/**
 * Re-measures `docs/receipts/message-metadata-bytes.md` against **real remote D1**.
 *
 * The figure sets §11B's shard thresholds, and `test/schema-drift.test.ts` fires whenever the `messages` or
 * `mailbox_items` shape changes so the number cannot silently outlive the schema it describes. When it
 * fires, the receipt is re-measured **before** the guard's constant is updated — editing the constant first
 * is precisely the landmine the guard exists to prevent.
 *
 * This existed as a manual procedure for the first two measurements. It is a script now because it has been
 * needed three times, and because a corpus rebuilt by hand each time is a corpus whose numbers are not
 * comparable — field widths dominate the cost, so placeholder data produces a fictional figure.
 *
 * ## Why remote, and why a scratch database
 *
 * D1 rejects `PRAGMA page_count` with SQLITE_AUTH, so page accounting is unavailable from inside a Worker
 * and local measurement is impossible. `wrangler d1 info --json` reports `database_size`, which is the only
 * honest source. It runs against a **throwaway** database, never the Node's `CATALOG`: the measurement
 * inserts thousands of synthetic rows, and doing that to somebody's mail would be indefensible.
 *
 * Usage:
 *   CLOUDFLARE_ACCOUNT_ID=<id> node scripts/measure-message-bytes.mjs
 *   CLOUDFLARE_ACCOUNT_ID=<id> node scripts/measure-message-bytes.mjs --keep   # leave it, to inspect
 *
 * The account id is required rather than inferred: an operator with several Cloudflare accounts gets
 * "More than one account available but unable to select one in non-interactive mode" from wrangler, and a
 * script that guessed would create a database in whichever account it felt like. Use the account the Node
 * itself is deployed in — a measurement of this schema belongs beside the thing it describes.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRATCH = "mailda-bytes-scratch";
const BATCH = 2_000;
const KEEP = process.argv.includes("--keep");

function wrangler(args, { quiet = true } = {}) {
  return execFileSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** `database_size` in bytes, from wrangler's own report. */
function sizeOf() {
  const out = wrangler(["d1", "info", SCRATCH, "--json"]);
  const info = JSON.parse(out.slice(out.indexOf("{")));
  const size = info.database_size ?? info.result?.database_size;
  if (typeof size !== "number") throw new Error(`no database_size in: ${out.slice(0, 400)}`);
  return size;
}

function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), "mailda-measure-"));
  const file = join(dir, "batch.sql");
  writeFileSync(file, sql, "utf8");
  try {
    wrangler(["d1", "execute", SCRATCH, "--remote", "--file", file, "--yes"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The corpus, at the widths the receipt records.
 *
 * Every width here is load-bearing: 64-character hex digests, RFC Message-IDs of realistic length, a
 * 70-character subject, org-scoped R2 keys, ISO-8601 timestamps, and typed-prefix ULIDs at their true width
 * (#6). 20 mailboxes, quarterly buckets. Change any of them and the figure stops being comparable to the
 * rounds before it.
 */
const ORG = "org_01J0000000000000000000MEAS";
const SUBJECT = "Invoice 4500219877 — revised delivery schedule for container MSKU4";
const DIGEST = "9f2c4a7b1e8d63f05a2c9b4e7d1f8a3c6b0e5d2f9a7c4b1e8d6f3a0c5b2e9d7f";

/**
 * Deterministic, and as wide as `ctx.id(prefix)` mints: the prefix, `_`, and a 26-character ULID body
 * (`packages/runtime/src/ctx.ts`), so 30 characters for `msg_` and 31 for `rcpt_`. Until 27 September 2026 this
 * padded the body to `26 - prefix.length` and every id was three or four characters short; the receipt
 * records what that understated.
 */
function ulid(prefix, n) {
  return `${prefix}_${n.toString(36).toUpperCase().padStart(26, "0")}`;
}

/**
 * Rows per INSERT. D1 rejects a single statement carrying 2,000 VALUES rows with SQLITE_TOOBIG, so the
 * corpus is chunked. This changes nothing about the measurement — the same rows and index entries exist
 * either way — but it is worth recording that the first attempt failed here rather than leaving the next
 * person to rediscover the limit.
 */
const ROWS_PER_STATEMENT = 50;

function chunked(rows, prefix) {
  const out = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    out.push(`${prefix} VALUES\n${rows.slice(i, i + ROWS_PER_STATEMENT).join(",\n")};\n`);
  }
  return out.join("");
}

/**
 * A sealed row preview's stored width (0068): base64 of a 12-byte IV, the ciphertext and a 16-byte tag. A
 * 120-character Latin line is ~120 bytes of UTF-8 and ~200 base64 characters sealed; a CJK line is ~360 bytes
 * and ~520 characters. Pseudo-random rather than repeated, so the figure is not the width of something a
 * page-level encoding could have shortened. Deterministic in `i`, for the reason every other field here is.
 */
function sealedPreview(i, chars) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let state = (i * 2654435761) >>> 0;
  let out = "";
  for (let n = 0; n < chars; n++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out += alphabet[state >>> 26];
  }
  return out;
}

function messagesSql(from, count) {
  const rows = [];
  for (let i = from; i < from + count; i++) {
    const id = ulid("msg", i);
    const bucket = `2026-Q${(i % 4) + 1}`;
    const rfc = `<CAJ123.${i.toString(36).padStart(20, "x")}@mail.example-supplier.com>`;
    rows.push(
      `('${id}','${ORG}','${bucket}','${ORG}/raw/${bucket}/${id}.eml','${DIGEST}',${18_000 + (i % 900)},` +
      `'${rfc}','${ulid("thr", i)}','${SUBJECT}','customer${i % 500}@example-supplier.com',` +
      `'2026-08-0${(i % 9) + 1}T12:00:00.000Z','2026-08-0${(i % 9) + 1}T12:00:04.000Z',` +
      `'${ulid("rcpt", i)}','2026-08-0${(i % 9) + 1}T12:00:04.000Z',` +
      `${i % 3 === 0 ? "NULL" : `'${rfc}'`},'${rfc}',NULL,'${ulid("cnv", i)}',` +
      // Authentication (0055), populated the way a real inbound row is: most mail passes all three, most
      // sending domains publish `p=none`, and the From domain is the sender's. Left null on a message the
      // Node materialised before 0055 — which a settled table has none of once the backfill runs.
      // Quarantine (0056): NULL on every row of a settled table — the switch is off by default, and a held
      // delivery is released or stays one of a handful. Populating it would measure a Node nobody runs.
      // Attachments (0057): counted on every row a settled Node has looked at, and most mail carries none.
      `'2026-08-0${(i % 9) + 1}T12:00:05.000Z','indexed',0,0,'pass','pass','pass','none','example-supplier.com',NULL,NULL,${i % 5 === 0 ? 1 : 0},0,NULL,` +
      // Row projections (0068), as a settled Node holds them: a display name (17 characters) on 70 % of
      // rows, a sealed preview on every row with body text (Latin, and one in ten CJK), generation 1,
      // projected, no attempts. The partial index `msg_preview_open` is then empty, which is its settled state.
      `${i % 10 < 7 ? `'Supplier ${String(i % 1000).padStart(3, "0")} desk'` : "NULL"},` +
      `'${sealedPreview(i, i % 10 === 9 ? 520 : 200)}',1,'projected',0,` +
      // Search forms (0071), as a settled Node holds them: both indexes written in form 1 on every row, and no
      // body cut (only a body past one D1 string is). Both selector indexes hold an entry for every row either
      // way, which is what a settled Node pays for.
      "1,1,NULL)",
    );
  }
  return chunked(rows,
    `INSERT INTO messages (id,org_id,time_bucket,blob_key,blob_sha256,blob_bytes,rfc_message_id,` +
    `thread_id,subject,from_addr,sent_at,received_at,ingress_receipt_id,created_at,in_reply_to,` +
    // `body_indexed_at` is **populated**, not left null. A null column costs about a byte and a
    // populated one costs an ISO timestamp — and on a Node that has run its backfill every row has
    // one, so measuring nulls would understate the deployed table.
    // `body_index_lease_until` is left null on purpose, unlike `body_indexed_at`: a lease is held for five
    // minutes out of a message's whole life, so a settled table has it null on every row and populating it
    // here would measure a state no deployed Node is ever in for more than a moment.
    //
    // `body_index_state`, `body_index_attempts` and `body_index_attempt_version` are NOT NULL with defaults,
    // so **every** row carries
    // them on a real Node — a measurement that omitted them would price a table nobody has. The nullable
    // error and retry columns are left null, which is their state for all but a handful of messages.
    `thread_root_rfc_id,parse_error,conversation_id,body_indexed_at,body_index_state,` +
    `body_index_attempts,body_index_attempt_version,auth_spf,auth_dkim,auth_dmarc,auth_dmarc_policy,` +
    `auth_from_domain,quarantined_at,quarantine_reason,attachments,attachments_dangerous,quarantine_note,` +
    `from_name,preview_sealed,preview_generation,preview_state,preview_attempts,` +
    `search_index_form,body_index_form,body_index_cut_from_bytes)`);
}

/**
 * `suffix` selects a *different mailbox*, not just a different row id.
 *
 * `mbi_unique` is on `(mailbox_id, message_id)`, so an "extra delivery" of the same message to the same
 * mailbox is not a thing that can exist — which is correct, and is what the shared-mailbox case actually
 * means: one arriving message landing in several mailboxes. Changing only the row id produced
 * SQLITE_CONSTRAINT, which is the schema being right and the corpus being wrong.
 */
function deliveriesSql(from, count, suffix) {
  const rows = [];
  for (let i = from; i < from + count; i++) {
    const bucket = `2026-Q${(i % 4) + 1}`;
    rows.push(
      `('${ulid("mbi", i * 2 + suffix)}','${ORG}','${ulid("mbx", (i % 20) + suffix * 20)}','${bucket}','${ulid("msg", i)}',` +
      `0,0,'2026-08-0${(i % 9) + 1}T12:00:00.000Z','2026-08-0${(i % 9) + 1}T12:00:04.000Z')`,
    );
  }
  return chunked(rows,
    `INSERT INTO mailbox_items (id,org_id,mailbox_id,time_bucket,message_id,change_number,flags,` +
    `sent_at,created_at)`);
}

/**
 * Filed places (0067): one row per person per message they put in Archive or Trash, so it is priced as its own
 * marginal figure rather than folded into a message's. Twenty people, as there are twenty mailboxes; four in
 * five filings are Archive. Every column is NOT NULL with no default, so an omitted one fails the INSERT
 * rather than pricing at zero. `receipt_id` and `accepted_at` are the message's own, as `src/places.ts` copies.
 */
function placesSql(from, count) {
  const rows = [];
  for (let i = from; i < from + count; i++) {
    rows.push(
      `('${ORG}','${ulid("usr", i % 20)}','${ulid("msg", i)}','${ulid("rcpt", i)}',` +
      `'2026-08-0${(i % 9) + 1}T12:00:04.000Z','${i % 5 === 4 ? "trash" : "archive"}','2026-09-0${(i % 9) + 1}T09:30:00.000Z')`,
    );
  }
  return chunked(rows,
    "INSERT INTO message_places (org_id,user_id,message_id,receipt_id,accepted_at,place,placed_at)");
}

/**
 * The three measured tables and every index on them, copied from the migrations.
 *
 * **A third copy of this schema.** `test/schema-drift.test.ts` compares its own copy against the migrated
 * database and fails when they diverge — that is what caught `body_indexed_at`. This one was compared against
 * nothing, so when #107 L2 added that column the script went on measuring the old shape and reported an
 * unchanged figure. Since 29 August `test/node/byte-measurement-corpus.test.ts` compares it with the drift
 * guard's copy, table by table.
 *
 * Left as a copy rather than read from `migrations/`, because the script builds a *scratch* database with only
 * these three tables and applying 68 migrations to get them would measure a different thing. But the hazard is
 * now written down where the next person editing a migration will find it.
 */
const SCHEMA = `
CREATE TABLE messages (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, time_bucket TEXT NOT NULL, blob_key TEXT NOT NULL,
  blob_sha256 TEXT NOT NULL, blob_bytes INTEGER NOT NULL, rfc_message_id TEXT NOT NULL,
  thread_id TEXT NOT NULL, subject TEXT NOT NULL, from_addr TEXT NOT NULL, sent_at TEXT NOT NULL,
  received_at TEXT NOT NULL, ingress_receipt_id TEXT NOT NULL, created_at TEXT NOT NULL,
  in_reply_to TEXT, thread_root_rfc_id TEXT, parse_error TEXT, conversation_id TEXT,
  body_indexed_at TEXT,
  body_index_state TEXT NOT NULL DEFAULT 'pending',
  body_index_attempts INTEGER NOT NULL DEFAULT 0,
  body_index_error TEXT,
  body_index_next_attempt_at TEXT,
  body_index_lease_until TEXT,
  body_index_attempt_version INTEGER NOT NULL DEFAULT 0,
  auth_spf TEXT, auth_dkim TEXT, auth_dmarc TEXT, auth_dmarc_policy TEXT, auth_from_domain TEXT,
  quarantined_at TEXT, quarantine_reason TEXT,
  attachments INTEGER, attachments_dangerous INTEGER,
  quarantine_note TEXT,
  from_name TEXT, preview_sealed TEXT, preview_generation INTEGER,
  preview_state TEXT NOT NULL DEFAULT 'pending', preview_attempts INTEGER NOT NULL DEFAULT 0,
  search_index_form INTEGER NOT NULL DEFAULT 0, body_index_form INTEGER NOT NULL DEFAULT 0,
  body_index_cut_from_bytes INTEGER
);
CREATE UNIQUE INDEX msg_by_receipt ON messages (ingress_receipt_id);
CREATE INDEX msg_by_thread ON messages (org_id, thread_id, sent_at);
CREATE INDEX msg_by_root ON messages (org_id, thread_root_rfc_id, sent_at);
CREATE INDEX msg_by_rfc_id ON messages (org_id, rfc_message_id);
CREATE INDEX msg_by_conversation ON messages (org_id, conversation_id, sent_at);
-- The backfill's selector (0044). An index costs bytes per row like any other, so a measurement omitting it
-- would price a table nobody has -- which is what the two rounds before this one did with the columns.
CREATE INDEX msg_body_index_due
  ON messages (body_index_state, body_index_lease_until, body_index_next_attempt_at);
-- The preview backfill's selector (0068). Partial, so it costs bytes only for rows not yet projected: empty
-- on the settled table this script builds, and counted here so it is priced rather than forgotten.
CREATE INDEX msg_preview_open ON messages (preview_state) WHERE preview_state <> 'projected';
-- The search re-index's selectors (0071). Not partial: an entry per row, so priced like msg_body_index_due.
-- 0071's trigger stores nothing per row and is left out.
CREATE INDEX msg_search_index_form ON messages (search_index_form);
CREATE INDEX msg_body_index_form ON messages (body_index_state, body_index_form);
CREATE TABLE mailbox_items (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, mailbox_id TEXT NOT NULL, time_bucket TEXT NOT NULL,
  message_id TEXT NOT NULL, change_number INTEGER NOT NULL, flags INTEGER NOT NULL,
  sent_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX mbi_unique ON mailbox_items (mailbox_id, message_id);
CREATE INDEX mbi_by_mailbox_bucket ON mailbox_items (org_id, mailbox_id, time_bucket, sent_at);
CREATE TABLE message_places (
  org_id TEXT NOT NULL, user_id TEXT NOT NULL, message_id TEXT NOT NULL, receipt_id TEXT NOT NULL,
  accepted_at TEXT NOT NULL, place TEXT NOT NULL CHECK (place IN ('archive', 'trash')), placed_at TEXT NOT NULL,
  PRIMARY KEY (user_id, message_id)
);
CREATE INDEX mpl_by_place ON message_places (user_id, place, accepted_at DESC, receipt_id DESC);
`;

const stages = [];
function stage(name) {
  const bytes = sizeOf();
  stages.push({ name, bytes });
  console.log(`  ${name.padEnd(42)} ${bytes.toLocaleString().padStart(12)}`);
  return bytes;
}

console.log(`Creating scratch database ${SCRATCH} (deleted at the end unless --keep)…`);
try {
  wrangler(["d1", "create", SCRATCH]);
} catch (error) {
  // wrangler reports this on stderr, not stdout — checking only stdout made a re-run crash instead of
  // continuing, which is how the first failed attempt left a database behind.
  const said = `${error.stdout ?? ""}${error.stderr ?? ""}${error}`;
  if (!said.includes("already exists")) throw error;
  // Reusing is wrong: a leftover database is not empty, so the first stage would not be an empty baseline
  // and every marginal figure derived from it would be quietly wrong. Start clean or do not start.
  throw new Error(
    `${SCRATCH} already exists. It is a leftover from an interrupted run and reusing it would corrupt the ` +
    `baseline. Delete it first:  npx wrangler d1 delete ${SCRATCH}`,
  );
}

try {
  console.log("\nStage                                            database_size");
  stage("Empty database");
  runSql(SCHEMA);
  const tables = SCHEMA.match(/CREATE TABLE/g).length;
  const indexes = SCHEMA.match(/CREATE (?:UNIQUE )?INDEX/g).length;
  stage(`Schema only (${tables} tables, ${indexes} named indexes)`);
  runSql(messagesSql(0, BATCH) + deliveriesSql(0, BATCH, 0));
  const afterFirst = stage(`+ ${BATCH} messages, 1 delivery each`);
  runSql(messagesSql(BATCH, BATCH) + deliveriesSql(BATCH, BATCH, 0));
  const afterSecond = stage(`+ ${BATCH} more messages`);
  runSql(deliveriesSql(0, BATCH, 1));
  const afterExtra = stage(`+ ${BATCH} extra deliveries only`);
  runSql(placesSql(0, BATCH));
  const afterPlaces = stage(`+ ${BATCH} filed places`);
  runSql(placesSql(BATCH, BATCH));
  const afterMorePlaces = stage(`+ ${BATCH} more filed places`);

  const perMessage = (afterSecond - afterFirst) / BATCH;
  const perDelivery = (afterExtra - afterSecond) / BATCH;
  console.log(`\nMarginal per message (with one delivery): ${perMessage.toFixed(1)} bytes`);
  console.log(`Marginal per extra delivery:              ${perDelivery.toFixed(1)} bytes`);
  // The second batch, for the per-message figure's reason: the first lands in an empty table.
  const perPlace = (afterMorePlaces - afterPlaces) / BATCH;
  console.log(`Marginal per filed place:                 ${perPlace.toFixed(1)} bytes`);
  console.log(`\nFor the receipt (values are integers): message_bytes ${Math.round(perMessage)}`);
} finally {
  if (KEEP) {
    console.log(`\nLeft ${SCRATCH} in place (--keep).`);
  } else {
    console.log(`\nDeleting ${SCRATCH}…`);
    try {
      wrangler(["d1", "delete", SCRATCH, "--skip-confirmation"]);
      console.log("  deleted.");
    } catch (error) {
      console.log(`  COULD NOT DELETE (${error}). Remove it by hand: npx wrangler d1 delete ${SCRATCH}`);
      process.exitCode = 1;
    }
  }
}
