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
      /*
       * Added by migration 0041 (#107 L2's body index). Re-measured against real remote D1 on 27 August 2026
       * *before* this constant was touched, as the two notes above insist — and the figure **did not move**:
       * 1,632 bytes per message, unchanged to the tenth of a byte.
       *
       * The explanation is page slack, and the receipt carries it: `database_size` is reported in 4,096-byte
       * pages, two ~1,632-byte rows share a page with roughly 830 bytes spare, and a populated ISO timestamp
       * per row fits in that without allocating a page. So *"it did not move"* means "this column fits in
       * space already paid for", not that it is free in principle.
       *
       * **The first re-run measured nothing**, which is why the reasoning is spelled out here as well as in
       * the receipt: `scripts/measure-message-bytes.mjs` **restates** this schema rather than reading it, so
       * it built the old table and reported an unchanged figure that was unchanged because the column was
       * absent. That copy is guarded by nothing — this test guards *this* copy — and the script now says so
       * above its own `SCHEMA` constant. A third copy of a schema is a third thing to keep true.
       */
      "body_indexed_at",
      /*
       * Added by migration 0044 (#107's body-index state machine). Re-measured against real remote D1 on
       * 28 August 2026 *before* this constant was touched, and the figure **moved**: 1,632 → 1,649 bytes per
       * message, which is 68,000 messages of shard capacity.
       *
       * The split is the interesting part. The four columns cost nothing measurable — two are NOT NULL with
       * defaults, so every row carries them, and they fit in the page slack this comment's neighbour
       * describes. The **index** cost all 17 bytes: `msg_body_index_due` is a second B-tree with an entry per
       * row and cannot hide in slack.
       *
       * The measuring script was wrong twice on the way there, both times in the direction of good news: the
       * first run omitted the columns, the second omitted the index. It restates this schema rather than
       * reading `migrations/`, which its own comment has warned about since the last time.
       */
      "body_index_state", "body_index_attempts", "body_index_error", "body_index_next_attempt_at",
      /*
       * Added by migration 0048 (audit P1-3's body-index lease). Re-measured against real remote D1 on
       * 29 August 2026 *before* this constant was touched, as every note above insists — and the figure held
       * at **1,649 bytes per message**.
       *
       * The contrast with the note above is the finding. That round's `msg_body_index_due` was a **second**
       * B-tree with an entry per row and cost 17 bytes a message. This round adds no structure: the same index
       * gains a nullable third column, NULL on every settled row, and a NULL costs a serial type in the entry
       * header rather than payload. The two table columns are the same story — one NULL everywhere and one an
       * integer `0`, which SQLite stores header-only with no payload at all. The *schema* grew by exactly one
       * page, which is the wider B-tree's root, and per row that is invisible.
       *
       * Read the receipt for what this does not establish: at page granularity, 1,648.6 against 1,649 is noise
       * rather than a decrease, and "fits in space already paid for" is not "nullable columns are free".
       *
       * The script omitted `body_index_attempt_version` from its corpus — a fourth round in a row of leaving
       * something out, and a fourth time the omission would have priced the missing thing at zero. Caught by
       * reading it rather than by anything failing, so
       * `test/node/byte-measurement-corpus.test.ts` now compares the script's schema against this constant.
       */
      "body_index_lease_until", "body_index_attempt_version",
    ],
    indexes: [
      "msg_by_receipt", "msg_by_root", "msg_by_thread", "msg_by_rfc_id", "msg_by_conversation",
      // 0044's selector, and the one thing in that migration that cost measurable bytes.
      "msg_body_index_due",
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
