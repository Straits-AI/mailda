-- Legal hold, as a predicate over a mailbox and a date window (#64, Layer 5).
-- Additive (#10 expand/contract): one new table, no ALTER of an existing one, so no bookmark gate.
--
-- ## Scope is evaluated at the moment of the act, never materialised
--
-- The requirement that decided the whole shape: **a hold placed on Tuesday must cover Wednesday's mail.** An
-- ongoing matter preserves what arrives while it runs, so a hold cannot be a frozen list of ids — it has to
-- be a question asked again at every destroying act. A materialised set needs active maintenance to stay
-- right, and a hold that must be maintained to keep covering things is a hold that will quietly stop.
--
-- So a hold is three values — a mailbox and two open-ended bounds — and coverage is
-- `mailbox_id = ? AND (from_date IS NULL OR from_date <= ?) AND (to_date IS NULL OR to_date >= ?)`,
-- evaluated in `src/holds.ts`. That is deliberately **coarser** than any matter it serves, because
-- over-holding costs storage and under-holding is unrecoverable. It is also how real holds are actually
-- written: preserve everything for these custodians from this date.
--
-- ## Both bounds are nullable, and NULL is the broad direction in each
--
-- `from_date` NULL means "from the beginning", `to_date` NULL means "ongoing, until lifted". The ordinary
-- first act is an urgent preservation with neither bound decided, and forcing a value there would make
-- somebody invent one under time pressure — a guess that then reads as a decision. Both NULLs widen
-- coverage rather than narrowing it, so the failure mode of an unset bound is over-holding.
--
-- Bounds are stored as full ISO-8601 instants, not bare dates. `src/holds.ts` normalises `2026-08-01` to
-- `…T00:00:00.000Z` and a `to_date` to `…T23:59:59.999Z` before writing, because the comparison is a string
-- comparison: a bare `to_date` of `2026-08-31` would otherwise fail to cover anything that happened *during*
-- 31 August, which is an under-hold at exactly the boundary a person thought they had included.
--
-- ## `matter_id` is nullable TEXT with no foreign key, and that is not laziness
--
-- The realistic first act precedes any matter: somebody realises within the hour that mail must be kept, and
-- ceremony in front of that is precisely how evidence is lost. And **there is no `matters` table** — #63
-- charted matters and settled that `legal_hold` is one of their types, but nothing builds them yet, so there
-- is no table for a foreign key to reference. When matters land, the constraint is theirs to add.
--
-- ## What this migration deliberately does not add
--
-- **No `lifted_at`, no `lifted_reason`.** #64 decided lifting takes dual approval — one stage of
-- `{count: 2}`, distinct on `user_id`, with a mandatory reason — and #61's approval machinery does not
-- exist. A nullable column nothing writes is a claim nothing enforces: every reader would have to guess
-- whether `lifted_at IS NULL` means "not lifted" or "lifting was never built", and the second is the truth.
-- Adding a column is additive, so the lift migration can add both when it can also write them. Until then
-- **every row in this table is an active hold**, which is what `src/holds.ts` relies on and says, and
-- `doctor`'s `legal_hold_lift_path` finding names the absent path rather than leaving it silent.
CREATE TABLE holds (
  id         TEXT PRIMARY KEY,   -- hld_<ulid>
  org_id     TEXT NOT NULL,

  -- The matter this hold cites, or NULL for one placed before anybody opened a matter. No foreign key:
  -- there is no matters table on this Node (#63 is charted, not built), so there is nothing to reference.
  matter_id  TEXT,

  -- The custodian. A hold covers one mailbox; several mailboxes means several holds, which keeps the
  -- coverage predicate an equality test and keeps "which mailboxes are held" answerable by a list.
  mailbox_id TEXT NOT NULL,

  -- The window, inclusive at both bounds. NULL on either side means unbounded in that direction.
  from_date  TEXT,
  to_date    TEXT,

  -- Who placed it and when. One org.admin, alone, effective immediately: placing only ever preserves, so
  -- its worst case is wasted bytes. The act is audited as hold.placed in the same transaction as this row.
  placed_by  TEXT NOT NULL,
  placed_at  TEXT NOT NULL
);

-- The coverage predicate's two equality columns, in the order it tests them.
--
-- `anyActiveHold` — the reconciler's org-wide suppression — reads the `org_id` prefix of this same index,
-- so one index serves both callers.
--
-- `from_date` is deliberately **not** a third column. It is a range test, the row has to be read anyway to
-- check `to_date`, and a mailbox realistically carries one or two holds — so a third column would sort a
-- handful of rows for an unmeasured gain. If an organization ever carries many windows on one mailbox, that
-- is the measurement to take before widening this.
CREATE INDEX hld_coverage ON holds (org_id, mailbox_id);
