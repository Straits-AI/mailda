-- One clock: time to first response. Not "an SLA engine".
--
-- #41 decided the *driver* (a cron sweep, because a due-time scan is idempotent by construction) and left
-- what starts and pauses a clock open, because that is a product question and the driver was the part with
-- measurable answers. This settles it, and the answer is narrower than "SLA".
--
-- ## Why first response, and only that
--
-- It is the one clock with an unambiguous definition: a customer wrote, and nobody has answered yet. Both
-- ends are events this Node observes directly — an inbound delivery, and an outbound hand-over — so nothing
-- has to be inferred.
--
-- Resolution time is the obvious second clock and it is deliberately absent: "resolved" would have to mean
-- `closed`, and closing is a human act with no policy attached to it. A resolution clock would therefore be
-- measuring how promptly somebody pressed a button, and presenting that as a service level is the kind of
-- number AGENTS.md says is worse than no number.
--
-- ## There is no pause, and therefore no `waiting-on-customer` state
--
-- A pause requires knowing whether the ball is with us or with them, which is a judgement nobody has made and
-- which this Node has no way to observe. A clock that pauses wrongly measures nothing, and one that requires
-- a human to remember to pause it measures diligence rather than response time.
--
-- So the clock is defined without one: it runs from **the oldest inbound message nobody has answered** to the
-- first outbound hand-over. Reply and it stops. The customer writes again and a new clock starts, from their
-- new message. That is what "first response" means to the person waiting, and it needs no state to express.
--
-- The cost, stated because it is real: a case where the customer owes *us* an answer keeps no clock at all,
-- so this measures responsiveness and not throughput. Adding a pause later needs an accumulated-elapsed
-- column and therefore a migration — a paused clock cannot be retrofitted onto a bare due timestamp.
--
-- ## The target is per mailbox and has no default
--
-- NULL means **no service level**, and that is the shipped state. A default would be this Node inventing a
-- promise nobody made to anybody: how fast a business answers its customers is not a platform limit, not
-- measurable from inside a Worker, and not ours to pick. `hold_window_seconds` has a default because there
-- is a receipt behind it; there is no receipt to be had here, and inventing one would dilute what a receipt
-- means (the same reasoning that left `AUTOSAVE_IDLE_MS` unbacked and said so).

-- NULL: this mailbox promises nothing, so no case in it carries a clock.
ALTER TABLE mailboxes ADD COLUMN first_response_minutes INTEGER;

-- When the clock started: the arrival of the oldest unanswered inbound message on this case.
ALTER TABLE cases ADD COLUMN response_due_at TEXT;
-- When it stopped, and what stopped it. NULL while nobody has answered.
ALTER TABLE cases ADD COLUMN first_response_at TEXT;
-- Set once, by the sweep, when a due time passed unanswered.
--
-- A breach is an **observation about a clock**, not a judgement about a person, so it does not change
-- `state`: §5C's rule against claiming an unobserved outcome cuts both ways, and a case that is late is not
-- thereby a different kind of case. It is a fact recorded beside the case and shown next to it.
ALTER TABLE cases ADD COLUMN response_breached_at TEXT;

-- The sweep's only query: due, unanswered, not yet recorded as breached. Partial, because the vast majority
-- of rows are none of those and indexing them would be paying for the wrong thing.
CREATE INDEX cas_response_due
  ON cases (org_id, response_due_at)
  WHERE response_due_at IS NOT NULL AND first_response_at IS NULL AND response_breached_at IS NULL;
