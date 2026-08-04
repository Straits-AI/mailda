-- Which key generation sealed each evidence object.
-- Additive (#10 expand/contract): no DROP, so no bookmark gate.
--
-- ADR 28 moves both KEKs into a per-Node Durable Object, which means existing objects are sealed
-- under a key the Node is about to stop using. Re-sealing has to be *resumable* — a shard can hold
-- ~8.5M messages (receipt: message-metadata-bytes.md) and one invocation cannot finish — so the
-- driver needs a column it can query and index. R2 metadata cannot be queried by value.
--
-- **R2 is the truth; this column is an index.** The generation that can actually decrypt an object is
-- recorded in that object's own R2 customMetadata, and the re-seal path reads it from there. This
-- column exists only to answer "which receipts might still need work", so a crash between the R2
-- write and the D1 update costs one redundant pass rather than an unreadable message.
--
-- NULL means generation 0: sealed before the vault existed, under the development constant.
ALTER TABLE ingress_receipts ADD COLUMN key_generation INTEGER;

-- Partial index: only rows still needing attention. Once re-sealing completes this index is empty
-- and costs nothing, which is the shape #11 established for the authorization path.
CREATE INDEX ir_needs_reseal ON ingress_receipts (org_id, key_generation)
  WHERE key_generation IS NULL OR key_generation = 0;
