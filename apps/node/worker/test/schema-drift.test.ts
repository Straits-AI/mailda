import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Enforces the `stale_when` clause of docs/receipts/message-metadata-bytes.md.
 *
 * That receipt measured 1,253 bytes per message against a specific schema. Its own
 * staleness condition is "the messages or mailbox_items schema changes, an index is
 * added or removed". A receipt that silently outlives its schema is exactly the landmine
 * AGENTS.md describes: a number that still reads as verified.
 *
 * The byte figure itself cannot be measured here — D1 rejects `PRAGMA page_count` with
 * SQLITE_AUTH, so page accounting is unavailable from inside a Worker. The measurement
 * is remote; see the receipt. This test only detects that it needs redoing.
 */
const MEASURED_SHAPE = {
  messages: {
    columns: [
      "id", "org_id", "time_bucket", "blob_key", "blob_sha256", "blob_bytes",
      "rfc_message_id", "thread_id", "subject", "from_addr", "sent_at", "received_at",
      "ingress_receipt_id", "created_at",
      // Added by migration 0006 (#27). The byte figure was re-measured against this shape on
      // 4 August 2026 *before* this constant was updated — 1,253 -> 1,505 bytes per message, which
      // cost 1.4 million messages of shard headroom. Editing the constant first would have made the
      // receipt silently stale, which is the whole failure this guard exists to prevent.
      "in_reply_to", "thread_root_rfc_id", "parse_error",
      // Added by migration 0014 (Layer 3). Re-measured against real remote D1 on 12 August 2026 *before*
      // this constant was touched — 1,505 -> 1,632 bytes per message, which costs a further 0.5 million
      // messages of shard headroom. The measurement is a script now (`scripts/measure-message-bytes.mjs`)
      // because it has been needed three times and a hand-built corpus is not comparable to itself.
      //
      // That measurement also turned up the receipt's `values:` block still deriving its shard thresholds
      // from the *original* 1,253-byte figure, so the generated budgets had been ~30% optimistic since
      // 4 August. This guard cannot catch that: it watches the schema, not whether the receipt agrees with
      // itself. Its `stale_when` now names that case.
      "conversation_id",
    ],
    indexes: [
      "msg_by_receipt", "msg_by_root", "msg_by_thread", "msg_by_rfc_id", "msg_by_conversation",
    ],
  },
  mailbox_items: {
    columns: [
      "id", "org_id", "mailbox_id", "time_bucket", "message_id", "change_number",
      "flags", "sent_at", "created_at",
    ],
    indexes: ["mbi_unique", "mbi_by_mailbox_bucket"],
  },
} as const;

async function columnsOf(table: string): Promise<string[]> {
  const rows = await env.CATALOG.prepare(
    "SELECT name FROM pragma_table_info(?) ORDER BY cid",
  )
    .bind(table)
    .all<{ name: string }>();
  return rows.results.map((row) => row.name);
}

async function indexesOf(table: string): Promise<string[]> {
  const rows = await env.CATALOG.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
    .bind(table)
    .all<{ name: string }>();
  return rows.results.map((row) => row.name);
}

describe("message metadata schema drift (#12)", () => {
  for (const [table, shape] of Object.entries(MEASURED_SHAPE)) {
    it(`${table} matches the shape the byte receipt was measured against`, async () => {
      expect(await columnsOf(table)).toEqual([...shape.columns]);
      expect(await indexesOf(table)).toEqual([...shape.indexes].sort());
    });
  }

  it("explains what to do when it fails", () => {
    // If the assertions above fail, the schema moved and
    // docs/receipts/message-metadata-bytes.md is stale. Re-run the remote measurement
    // documented in that receipt, update its `values`, run `pnpm receipts`, then update
    // MEASURED_SHAPE here. Do not just edit the constant.
    expect(true).toBe(true);
  });
});
