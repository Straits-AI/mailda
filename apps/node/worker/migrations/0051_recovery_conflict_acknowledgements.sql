-- A permanent loss that nobody can acknowledge becomes a warning nobody reads.
--
-- `checkRecoveryConflicts` scans every completed restore and keeps the Node `degraded` while any of them
-- collided with a live key. That is correct and it has no end: two different secrets cannot share one
-- generation number, so mail sealed under the escrowed key of that generation stays unreadable, and no later
-- restore repairs it. The check said so and offered no way to say "we have assessed this".
--
-- The failure mode is the ordinary one for permanent alarms. An operator who has read the finding, worked out
-- what was sealed in that window, and concluded the loss is bounded still sees `degraded` on every subsequent
-- morning — so `degraded` stops meaning anything, and the next real one is read as the same old noise. The
-- finding stays; what changes is whether it decides the verdict.
--
-- ## Immutable, and keyed to the generations rather than the restore
--
-- There is no update and no delete. An acknowledgement is a statement somebody made on a date about a
-- specific set of generations, and editing one afterwards would make the record of the assessment less
-- trustworthy than the memory of it.
--
-- `generations` is the sorted, comma-joined list the restore reported as conflicted, and it is part of the
-- key on purpose: acknowledging a restore is not acknowledging whatever that restore might be found to have
-- collided with later. If the conflicted set ever differs from what was assessed, the acknowledgement no
-- longer matches and the finding returns — which is the fail-closed direction, and the only one that makes
-- the record mean what it says.
CREATE TABLE IF NOT EXISTS recovery_key_conflict_acknowledgements (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  -- The restore whose collision this assesses. Not a foreign key to `recovery_restores` for the reason the
  -- audit chain is not one either: this record must outlive anything that could remove its subject.
  restore_id TEXT NOT NULL,
  -- The exact conflicted generations, sorted and comma-joined, as the restore's detail reported them.
  generations TEXT NOT NULL,
  -- Who assessed it. A person, always: `assertAdmin` gates the route, and an agent cannot hold `org.admin`.
  assessed_by TEXT NOT NULL,
  assessed_at TEXT NOT NULL,
  -- What was examined — which mailboxes, which window. Free text, because the shape of an incident is not
  -- something this schema should pretend to know.
  scope TEXT NOT NULL,
  -- What was concluded. Required and non-empty: an acknowledgement with no conclusion is a dismissal, and a
  -- dismissal is what this table exists to be distinguishable from.
  conclusion TEXT NOT NULL
);

-- One acknowledgement per restore-and-generation-set. A second attempt is refused rather than layered, so the
-- trail cannot accumulate several conclusions about one incident with nothing saying which one stands.
CREATE UNIQUE INDEX IF NOT EXISTS recovery_conflict_ack_unique
  ON recovery_key_conflict_acknowledgements (org_id, restore_id, generations);
