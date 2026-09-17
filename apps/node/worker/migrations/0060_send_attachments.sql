-- Attachments on an authored send: what the author attached, judged and stored as evidence at the seal.
-- phase: expand
--
-- One row per part, the bytes under `${orgId}/sent/${manifestId}/att-<ordinal>` beside the two bodies, with
-- the plaintext hash the effect envelope binds and the evidence verifier checks (the same shape as
-- `body_typed_key`/`body_typed_sha256`, in a table because a send has many). `verdict` is what
-- `src/attachments.ts` said of the part — the same judge that reads inbound mail — and the seal refuses a
-- dangerous one, so every row here is `plain` or `archive`: recorded so the rule can be seen to have run.
-- `reconcile.ts` needs no change: the referent of any object under a manifest's prefix is the manifest row.
CREATE TABLE send_attachments (
  id            TEXT PRIMARY KEY,   -- sat_<ulid>
  org_id        TEXT NOT NULL,
  manifest_id   TEXT NOT NULL,
  ordinal       INTEGER NOT NULL,
  filename      TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  blob_key      TEXT NOT NULL,
  verdict       TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX sat_by_manifest ON send_attachments (manifest_id, ordinal);
CREATE INDEX sat_by_org ON send_attachments (org_id, manifest_id);
