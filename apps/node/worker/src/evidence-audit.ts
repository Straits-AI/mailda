import { BUDGETS } from "@mailda/budgets";

import { EvidenceMissing, getEvidence, runKeyCache, sha256Hex } from "./evidence-store.ts";
import { INVENTORY_REFERENTS, splitCursor } from "./evidence-inventory.ts";

/**
 * Does the evidence still say what this Node recorded it saying? (#92)
 *
 * ## Why this is the first layer of the restore drill and not a nice-to-have
 *
 * #92 asks for an export that has been restored into a clean Cloudflare account, and says of the step that
 * proves sampled messages decrypt and hash-verify: *"Step 5 is the one that makes the rest true. An export
 * nobody has restored is a claim, and this ticket exists because of a claim."*
 *
 * That step needs a verifier, and there was none — for a backup **or** for the live Node. `doctor` sends one
 * HEAD at the bucket, which answers "is R2 reachable"; nothing answered "is what is in it what D1 says it
 * is". So the same gap sat under the running Node the whole time: an object silently truncated, re-sealed
 * under a lost generation, or replaced would be found by the person opening that message, years later.
 *
 * `ingress_receipts` already carries the link that makes this checkable without trusting anything:
 * `blob_key` names the R2 object and `blob_sha256` is the SHA-256 of the **plaintext**, recorded at ingress
 * and deliberately not of the ciphertext — so it survives a re-seal under a new key generation, which is
 * exactly what a hash of the stored bytes would not.
 *
 * ## All four prefixes, from the inventory's list rather than a second one (#131)
 *
 * This swept `ingress_receipts` **only**, while `evidence-inventory.ts` walked all four prefixes the Worker
 * writes. So the two halves of #92's layer disagreed about what evidence *is*, and a Node whose evidence is
 * drafts or staged sends — which is every Node before its domain is bound, and any Node that composes more
 * than it receives — passed verification with nothing checked.
 *
 * Measured on the first real backup: three sealed drafts with recorded hashes, and
 *
 *     3 object(s) listed
 *     0 checked, 0 fault(s)
 *
 * Every number honest, and the conclusion drawn from them false. It is the shape this repository keeps
 * catching, structural rather than cosmetic.
 *
 * The tables come from **`INVENTORY_REFERENTS`**, grouped by table. Not a copy of it, and not a list of
 * prefixes written again here: #67 and #74 were each a prefix the Worker wrote and a listing missed, and
 * #131 is the same defect arriving as a difference in *coverage* between two lists rather than a gap in one.
 * A fifth prefix now reaches this verifier because it reached the inventory.
 *
 * ## Row-driven, and that is the half a bucket walk cannot do
 *
 * It would be tempting to verify the inventory's output directly — it already pairs every object with its
 * recorded hash. But a walk of the *bucket* can never find a **missing** object: an R2 listing does not
 * contain what is absent. Rows name objects, so only a walk of rows can find a receipt whose evidence is
 * gone. The two directions answer different questions and the product needs both — the inventory reports
 * `unaccounted` (an object no row names), and this reports `missing` (a row whose object is not there).
 *
 * ## What a failure means, stated separately for each kind
 *
 * The three ways this fails are not the same finding, and collapsing them into "corrupt" would throw away
 * the part an operator acts on:
 *
 *   - **missing** — D1 has a receipt and R2 has no object. Evidence is gone; the metadata that says it
 *     existed is not.
 *   - **unreadable** — the object is there and will not open. The key generation it names is one this vault
 *     cannot produce, which is the ADR 28 loss scenario and the reason the escrow exists.
 *   - **altered** — it opened, and the plaintext hashes to something else. The bytes changed after ingress.
 *
 * The first two can be true of a Node that is otherwise healthy. The third cannot happen by accident.
 *
 * ## Bounded, resumable, and honest about cost
 *
 * Every message costs an R2 `get` and a decrypt, so this cannot be a whole-database sweep in one request —
 * the per-invocation subrequest cap would end it partway and report a clean partial result, which is the
 * failure mode this file exists to prevent. It runs in batches with a measured bound
 * (`docs/receipts/evidence-integrity-cost.md`) and returns where to resume, the way `verifyChain` does.
 *
 * The vault key cache is passed for the whole batch: one RPC for the opening key of each generation rather
 * than one per message, which is the difference between a batch fitting in an invocation and not.
 */

/**
 * How many objects one invocation opens, which is what the receipt measured (#131).
 *
 * A bound on **objects**, not rows, and the rename is the substance. One `send_manifests` row stages up to
 * three objects, so a row bound would have meant three different costs depending on which table was being
 * swept — and the cost this number exists to bound is the R2 `get` and the decrypt, which happen per object.
 * The row limit per table is derived below.
 */
const BATCH = BUDGETS["evidence.verify_objects"];

/**
 * The tables to sweep and the key/hash columns on each, grouped from the inventory's referent list.
 *
 * Grouped rather than iterated flat so `send_manifests` is read **once** for its three objects instead of
 * three times: a row's typed, normalized and submitted bodies come out of one page, and paging the same table
 * three times would triple the D1 queries to check the same sends.
 *
 * Order follows `INVENTORY_REFERENTS`, and it has to be stable — the cursor is an index into this list, so a
 * reorder between two requests of one sweep would resume in the wrong table. That is why it is derived once
 * at module load from a `const` list rather than rebuilt per call.
 */
const GROUPS: Array<{
  table: string;
  columns: ReadonlyArray<{ key: string; hash: string; bytes: string | null }>;
}> = (() => {
  const byTable = new Map<string, Array<{ key: string; hash: string; bytes: string | null }>>();
  for (const referent of INVENTORY_REFERENTS) {
    const columns = byTable.get(referent.table) ?? [];
    columns.push({ key: referent.key, hash: referent.hash, bytes: referent.bytes });
    byTable.set(referent.table, columns);
  }
  return [...byTable].map(([table, columns]) => ({ table, columns }));
})();

/** The tables this verifier sweeps, for the closed-world test that compares them against the inventory's. */
export const VERIFIED_TABLES = GROUPS.map((one) => one.table);

/** Why one object did not check out. Three kinds, because an operator acts on them differently. */
export type EvidenceFault = {
  /**
   * The row that names the object, and the table it is in.
   *
   * Was `receiptId`, which stopped being true the moment this swept anything but `ingress_receipts` (#131) —
   * a draft's id reported under that name is a field lying about which table to look in, during an incident
   * where somebody is trying to find one row.
   */
  rowId: string;
  table: string;
  /** Which of the row's objects, for a table that stages more than one. */
  column: string;
  blobKey: string;
  kind: "missing" | "unreadable" | "altered";
  detail: string;
};

export interface EvidenceVerdict {
  /**
   * Objects opened and hashed. **Not rows read**, and the two differ on `send_manifests`.
   *
   * A row whose optional object was never staged — a structured-fidelity send has no `submitted_key` —
   * contributes nothing here, because nothing was checked. Counting it would be the same false arithmetic
   * this file exists to prevent, one level down: a sweep reporting work it did not do.
   */
  checked: number;
  /** The cursor this batch started at, echoed so a caller can tell a resumed run from a fresh one. */
  after: string | null;
  /** Which table this batch swept, so a partial sweep says what it covered rather than only how much. */
  table: string | null;
  intact: boolean;
  /**
   * Every fault in this batch, not just the first.
   *
   * `verifyChain` stops at the first break because a hash chain after a break is meaningless. Evidence
   * objects are independent, so stopping early would report one lost message and hide four hundred — and the
   * number of affected messages is the first thing an operator needs.
   */
  faults: EvidenceFault[];
  /** Null when the last page came back short, which is the only reliable end-of-table signal here. */
  resumeAfter: string | null;
  /** What the batch cost, so a caller sizing a full sweep is not guessing. */
  bytesRead: number;
}

export async function verifyEvidence(
  env: Env,
  orgId: string,
  after: string | null = null,
  /**
   * The object bound, defaulting to the measured one.
   *
   * A seam rather than a constant read directly, and it exists because of a mutation that survived: forcing
   * `resumeAfter` to null left every test green, since none of them filled a page of 200 and a short page
   * legitimately ends a sweep. The branch that decides whether a sweep *continues* was therefore never taken
   * by any test. Seeding 200 messages would reach it and make this the slowest file in the suite for one
   * boolean; a caller-supplied bound reaches it in three.
   *
   * Production callers pass nothing. The route does not read it from the query string, so an operator cannot
   * widen the batch past what the receipt measured.
   */
  batch: number = BATCH,
): Promise<EvidenceVerdict> {
  const { index, within } = splitCursor(after);
  const faults: EvidenceFault[] = [];
  const cache = runKeyCache();
  let bytesRead = 0;
  /*
   * Counted in the loop rather than taken from `rows.length`, and now they genuinely differ: a
   * `send_manifests` row carries up to three objects and a structured-fidelity send carries two. A count
   * taken from the page would report rows *fetched* as objects *checked*, which is the shape of every false
   * clean bill of health in this file's reasoning.
   */
  let checked = 0;

  /*
   * Walk forward until a table yields rows or they run out. **An empty table must not end the sweep** — a
   * Node with no drafts would otherwise stop before reaching its exports and report a partial sweep as a
   * complete one, which is the identical lesson `inventoryPage` carries about an empty prefix. The two
   * halves of #92's layer failing the same way for the same reason is what #131 was.
   */
  let at = index;
  let rows: Array<Record<string, string | number | null>> = [];
  let group = GROUPS[at];
  let cursor = within ?? null;
  while (at < GROUPS.length) {
    group = GROUPS[at] as (typeof GROUPS)[number];
    /*
     * Rows per page derived from the object bound, so every table costs the same **per invocation** rather
     * than per row: 200 rows of receipts and 66 rows of sends both open at most 200 objects. `Math.max(1, …)`
     * because a bound below the column count would otherwise page zero rows forever.
     */
    const perPage = Math.max(1, Math.floor(batch / group.columns.length));
    const columns = group.columns
      .flatMap((one) => [one.key, one.hash, ...(one.bytes === null ? [] : [one.bytes])])
      .join(", ");
    /*
     * Keyset pagination on the primary key rather than LIMIT/OFFSET. A sweep of a live Node runs while mail
     * arrives, and OFFSET would skip a row every time one sorted before the current page appeared. Ids are
     * ULIDs, so ordering by id is ordering by arrival and a new row can only land after the cursor.
     */
    const page = await env.CATALOG.prepare(
      `SELECT id, ${columns} FROM ${group.table}
        WHERE org_id = ?1 AND (?2 IS NULL OR id > ?2)
        ORDER BY id LIMIT ?3`,
    )
      .bind(orgId, cursor, perPage)
      .all<Record<string, string | number | null>>();

    rows = page.results;
    if (rows.length > 0) break;
    at += 1;
    cursor = null;
  }

  if (at >= GROUPS.length || group === undefined) {
    return { checked: 0, after, table: null, intact: true, faults: [], resumeAfter: null, bytesRead: 0 };
  }

  const swept = group;
  const perPage = Math.max(1, Math.floor(batch / swept.columns.length));

  for (const row of rows) {
    const rowId = String(row.id);
    for (const column of swept.columns) {
      const blobKey = row[column.key];
      const recorded = row[column.hash];
      /*
       * **A column that was never staged is not a missing object.** `send_manifests.submitted_key` is null
       * unless the send had authored fidelity, so treating null as absent evidence would report a fault on
       * every structured send this Node ever made — a verifier crying wolf on correct data, which is how a
       * real fault stops being read.
       */
      if (typeof blobKey !== "string" || blobKey === "" || typeof recorded !== "string") continue;

      checked += 1;
      let plaintext: Awaited<ReturnType<typeof getEvidence>>;
      try {
        plaintext = await getEvidence(env, blobKey, cache);
      } catch (error) {
        /*
         * `EvidenceMissing` is a distinct class precisely so this does not have to match on a message. Anything
         * else that throws is a decrypt failure — a generation this vault cannot produce, or a truncated
         * object — and is reported as `unreadable` rather than swallowed. A verifier that treats an error as a
         * pass is worse than no verifier.
         */
        faults.push({
          rowId,
          table: swept.table,
          column: column.key,
          blobKey,
          kind: error instanceof EvidenceMissing ? "missing" : "unreadable",
          detail: error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error),
        });
        continue;
      }

      bytesRead += plaintext.length;
      const actual = await sha256Hex(plaintext);
      if (actual !== recorded) {
        const sealedBytes = column.bytes === null ? null : row[column.bytes];
        faults.push({
          rowId,
          table: swept.table,
          column: column.key,
          blobKey,
          kind: "altered",
          detail: `recorded ${recorded.slice(0, 16)}…, opened to ${actual.slice(0, 16)}…`
            + (typeof sealedBytes !== "number" || sealedBytes === plaintext.length
              ? ""
              : ` (${sealedBytes} bytes when sealed, ${plaintext.length} now)`),
        });
      }
    }
  }

  /*
   * A short page ends **this table**, not the sweep — the next request starts the next table at its
   * beginning. Returning null here because one table ran out would report the tables never opened as
   * verified, which is #131 exactly, rebuilt inside the fix for it.
   *
   * A full page resumes in the same table. Returning a cursor whenever the page was non-empty would make a
   * caller loop forever on the last batch; returning null on a full page would stop early and report the part
   * it did as the whole, which is the more dangerous of the two mistakes.
   */
  const resumeAfter = rows.length < perPage
    ? (at + 1 < GROUPS.length ? `${at + 1}:` : null)
    : `${at}:${rows.at(-1)?.id ?? ""}`;

  return {
    checked,
    after,
    table: swept.table,
    intact: faults.length === 0,
    faults,
    resumeAfter,
    bytesRead,
  };
}
