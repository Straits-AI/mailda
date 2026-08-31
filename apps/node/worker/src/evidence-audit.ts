import { BUDGETS } from "@mailda/budgets";

import { EvidenceMissing, getEvidence, runKeyCache, sha256Hex } from "./evidence-store.ts";

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

const BATCH = BUDGETS["evidence.verify_batch"];

/** Why one receipt's evidence did not check out. Three kinds, because an operator acts on them differently. */
export type EvidenceFault = {
  receiptId: string;
  blobKey: string;
  kind: "missing" | "unreadable" | "altered";
  detail: string;
};

export interface EvidenceVerdict {
  checked: number;
  /** The receipt id this batch started after, echoed so a caller can tell a resumed run from a fresh one. */
  after: string | null;
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
   * The page size, defaulting to the measured bound.
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
  /*
   * Keyset pagination on the primary key rather than LIMIT/OFFSET. A sweep of a live Node runs while mail
   * arrives, and OFFSET would skip a receipt every time a row sorted before the current page appeared. Ids
   * are ULIDs, so ordering by id is ordering by arrival and a new row can only land after the cursor.
   */
  const page = await env.CATALOG.prepare(
    `SELECT id, blob_key, blob_sha256, raw_bytes FROM ingress_receipts
      WHERE org_id = ?1 AND (?2 IS NULL OR id > ?2)
      ORDER BY id LIMIT ?3`,
  )
    .bind(orgId, after, batch)
    .all<{ id: string; blob_key: string; blob_sha256: string; raw_bytes: number }>();

  const rows = page.results;
  const faults: EvidenceFault[] = [];
  const cache = runKeyCache();
  let bytesRead = 0;
  /*
   * Counted in the loop rather than taken from `rows.length`. The two are equal today because nothing stops
   * early — and that is exactly why the difference matters: if anything ever does, a count taken from the
   * page would report the messages it *fetched* as the messages it *checked*, which is the shape of every
   * false clean bill of health in this file's reasoning.
   */
  let checked = 0;

  for (const row of rows) {
    checked += 1;
    let plaintext: Awaited<ReturnType<typeof getEvidence>>;
    try {
      plaintext = await getEvidence(env, row.blob_key, cache);
    } catch (error) {
      /*
       * `EvidenceMissing` is a distinct class precisely so this does not have to match on a message. Anything
       * else that throws is a decrypt failure — a generation this vault cannot produce, or a truncated
       * object — and is reported as `unreadable` rather than swallowed. A verifier that treats an error as a
       * pass is worse than no verifier.
       */
      faults.push({
        receiptId: row.id,
        blobKey: row.blob_key,
        kind: error instanceof EvidenceMissing ? "missing" : "unreadable",
        detail: error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error),
      });
      continue;
    }

    bytesRead += plaintext.length;
    const actual = await sha256Hex(plaintext);
    if (actual !== row.blob_sha256) {
      faults.push({
        receiptId: row.id,
        blobKey: row.blob_key,
        kind: "altered",
        detail: `recorded ${row.blob_sha256.slice(0, 16)}…, opened to ${actual.slice(0, 16)}…`
          + (plaintext.length === row.raw_bytes ? "" : ` (${row.raw_bytes} bytes at ingress, ${plaintext.length} now)`),
      });
    }
  }

  return {
    checked,
    after,
    intact: faults.length === 0,
    faults,
    /*
     * A short page is the end. Returning a cursor whenever the page was non-empty would make a caller
     * loop forever on the last batch; returning null on a full page would stop a sweep early and report the
     * part it did as the whole, which is the more dangerous of the two mistakes.
     */
    resumeAfter: rows.length < batch ? null : (rows.at(-1)?.id ?? null),
    bytesRead,
  };
}
