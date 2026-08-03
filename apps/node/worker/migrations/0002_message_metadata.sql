-- Additive (#10 expand/contract). Message metadata, sharded by (mailbox, time bucket).
--
-- Per §12, raw MIME and attachments never live here — R2 holds them and this table
-- carries the pointer and hash. Preview and search representations are bounded.
CREATE TABLE messages (
  id            TEXT PRIMARY KEY,          -- msg_<ulid>
  org_id        TEXT NOT NULL,
  time_bucket   TEXT NOT NULL,             -- routing + sort unit, e.g. 2026-Q3
  blob_key      TEXT NOT NULL,             -- R2 object key for the raw MIME
  blob_sha256   TEXT NOT NULL,             -- hex, 64 chars
  blob_bytes    INTEGER NOT NULL,
  rfc_message_id TEXT NOT NULL,            -- the provider/sender Message-ID header
  thread_id     TEXT NOT NULL,             -- thr_<ulid>
  subject       TEXT NOT NULL,
  from_addr     TEXT NOT NULL,
  sent_at       TEXT NOT NULL,
  received_at   TEXT NOT NULL,
  ingress_receipt_id TEXT NOT NULL,        -- the derived key (#9)
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX msg_by_receipt ON messages (ingress_receipt_id);
CREATE INDEX msg_by_thread ON messages (org_id, thread_id, sent_at);

-- One delivery of one message into one mailbox (§12 invariant 3: access is evaluated
-- per delivery, not per message).
CREATE TABLE mailbox_items (
  id            TEXT PRIMARY KEY,          -- mbi_<ulid>
  org_id        TEXT NOT NULL,
  mailbox_id    TEXT NOT NULL,
  time_bucket   TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  change_number INTEGER NOT NULL,          -- §12 invariant 5, DO-serialized
  flags         INTEGER NOT NULL,
  sent_at       TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
-- Derived key (#9): one delivery of a message into a mailbox, once.
CREATE UNIQUE INDEX mbi_unique ON mailbox_items (org_id, mailbox_id, message_id);
-- The inbox read: newest first within a mailbox and bucket. Prefix order is
-- load-bearing, per the lesson in docs/receipts/authz-check-rows-read.md.
CREATE INDEX mbi_by_mailbox_bucket ON mailbox_items (org_id, mailbox_id, time_bucket, sent_at);
