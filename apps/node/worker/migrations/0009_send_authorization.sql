-- Backfill `send.propose` for Nodes claimed before sending required authorization.
--
-- Layer 2 makes sealing a manifest conditional on holding `send.propose` on the mailbox. `claim.ts`
-- grants it from now on, but a Node claimed yesterday has only `mailbox.content.read` — so without this
-- the upgrade that adds the check is the upgrade that stops the owner sending, on every existing Node.
--
-- The grant goes to whoever already holds `mailbox.content.read`, which on an existing Node is exactly
-- the owner: it is the only relation `claim.ts` ever wrote, and no mutation path has existed since
-- (`audit-coverage.test.ts` recorded that absence, and this migration is why that record changes).
-- Widening read to send is safe *here* precisely because there is no case yet where the two differ; the
-- moment membership administration lands they will, and this migration must not be used as a precedent
-- for equating them.
--
-- The id is derived rather than minted, and that is a deliberate deviation from #6's rule that every
-- identifier is a typed-prefix ULID. SQLite cannot generate one — there is no ULID function and no
-- randomness worth the name — and the alternative, a code-side backfill, is a step nothing guarantees
-- runs before the first send. A deterministic id also makes this migration idempotent under the UNIQUE
-- index below, which a random one would not be.
INSERT OR IGNORE INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
SELECT
  'rt_backfill_send_' || substr(object_id, 1, 26),
  org_id,
  subject_id,
  'send.propose',
  'mailbox',
  object_id,
  created_at
FROM relationship_tuples
WHERE relation = 'mailbox.content.read' AND object_type = 'mailbox';
