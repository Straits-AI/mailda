-- The Butler pause: #66's second abuse breaker, latched on the Butler rather than on a version (#75, §18,
-- Layer 5 over Layer 4's substrate). Additive (#10 expand/contract): one new table with two indexes, plus
-- one index on an existing table. No DROP, no rewrite, no bookmark gate.
--
-- ## Why this table exists now and could not exist in #66
--
-- #66 decided the shape and then named this part **absent**, with the evidence: there was no `butlers` table,
-- so there was no `butler_id` to key a pause on, no run to place one from, and no trigger point to evaluate
-- it at. #75 recorded that as a deliberate absence rather than a gap, on #60's governing rule — *a condition
-- backed by no data is a policy that silently never fires*. 0027 and 0028 built the three things it named:
-- `butlers`, `butler_versions`, `butler_runs` and `butler_run_effects`. So the decision is implemented as
-- written rather than re-litigated.
--
-- ## Keyed on `butler_id`, and that is the load-bearing half of the decision
--
-- Not on `butler_versions.id`. #49 froze a published version in both AST and source text with two database
-- triggers, so auto-disabling **cannot** be a mutation of the version — invariant 9 forbids it. That much only
-- rules out one implementation. What decides *this* key is the consequence: **republishing a fixed Butler must
-- not silently clear a pause the machine placed.** With a version-keyed pause, an operator who changes one
-- comment and publishes has re-armed a Butler the machine stopped, with nobody deciding it was safe.
--
-- The cost is accepted deliberately and is stated where somebody will meet it: a fixed Butler needs an
-- **explicit resume** as well as a publish. That is the act somebody should have to perform.
--
-- An enablement pointer on `butlers` was rejected in #66 for conflating *not deployed* with *stopped by a
-- breaker*: the reason a Butler is not running would stop being recorded in the thing that stopped it, and
-- recovery would look like an ordinary deploy in the audit trail.
--
-- ## `domain_pauses` is the closest precedent, and this differs from it in exactly one place
--
-- Read 0026 first: same latched shape, same in-force predicate as a partial UNIQUE index, same argument for
-- why an abuse breaker latches while a rate breaker is a question re-asked. What differs is **who places it**,
-- and every other difference below follows from that one.
--
--   domain_pauses   a person asks, two administrators agree. So `placed_at` is NULL until they do, and the
--                   row's whole purpose while NULL is to hold the reason the second approver reads.
--   butler_pauses   the **machine** places it, at trigger time, from a windowed count it just computed. There
--                   is nobody to ask and nothing to wait for, so there is no request state: the row exists
--                   only when the pause exists, and `placed_at` is NOT NULL.
--
-- A nullable `placed_at` here would be a representable state no path in this Node produces — the placeholder
-- shape `test/node/placeholder-columns.test.ts` exists to catch, reached through a column rather than a value.
--
-- ## No human placement path, said plainly rather than left to be discovered
--
-- Nothing in this Node lets a person pause a Butler. That is #75's scope rather than an oversight: the ticket
-- builds the breaker, and a breaker is placed by a machine. What a person can do today to stop a Butler is
-- revoke the relations granted to its `btl_` id — which stops it at its next effect, since a Butler's
-- principal is the Butler (`src/butler/principal.ts`) — or publish a policy denying its sends. Both are
-- audited and neither needs this table.
--
-- **And there is deliberately no `placed_by` column.** One was written and removed, and the removal is the
-- rule this repository already has rather than a preference: every pause is placed by the machine, so the
-- column's only value would be NULL, and *"a column whose only value is NULL is the placeholder shape
-- `test/node/placeholder-columns.test.ts` exists to catch"* — 0028's own words about its own seam. The actor
-- is already recorded where an actor belongs: the `butler.paused` audit entry carries `actor_user_id = NULL`
-- and `actor_kind = 'node'`. The day a person can place one, the column arrives with the act in an additive
-- migration (#10), which is cheaper than carrying an empty one until then.

CREATE TABLE butler_pauses (
  id         TEXT PRIMARY KEY,   -- bpz_<ulid>
  org_id     TEXT NOT NULL,

  -- The Butler, never a version. See the header: this is the decision, not an implementation detail of it.
  -- No foreign key, for the reason 0018 gives about `matter_id` and 0026 repeats about `domain`: this schema
  -- declares none anywhere.
  butler_id  TEXT NOT NULL,

  -- Why the machine stopped it, as a machine token — `PAUSE_REASONS` in `src/butler/pause.ts` is the closed
  -- set, and it is the same discipline `BREAKER_REASONS` and `POLICY_REASONS` follow. One member today
  -- (`loop_detected`), and it is a list rather than a bare constant so a second detector cannot arrive
  -- without joining a vocabulary something reads.
  reason     TEXT NOT NULL,

  -- The four parts AGENTS.md §3 requires, as one sentence: the named budget with its number, the ask, the
  -- identifiers, and the receipt that says how to change the limit.
  --
  -- Stored rather than recomputed, and that is the point of the column. The pause is placed from a **windowed**
  -- count, so by the time an administrator reads it the rows behind the number have aged out of the window and
  -- the count cannot be reproduced. `send.rate_limited` records the same fact for the same reason
  -- (`src/audit.ts`: *"names a threshold that was crossed by rows which will have aged out"*), and here it is a
  -- column because the person deciding whether to resume is reading the pause, not the trail.
  detail     TEXT NOT NULL,

  -- The delivery whose arrival took the count over the limit: a `msg_<ulid>`.
  --
  -- NOT NULL, because every pause is machine-placed at trigger time and a trigger has a delivery. It is what
  -- makes the pause diagnosable rather than merely visible: from this id an administrator reads the message,
  -- its conversation, and — through `butler_runs.trigger_key` — every earlier run in the chain.
  tripped_by TEXT NOT NULL,

  -- Not nullable, unlike `domain_pauses.placed_at`. See the header: there is no request state here, so a row
  -- that exists is a pause that is in force until it is resumed. And there is no `placed_by` beside it,
  -- because the machine is the only placer and an always-NULL column is the placeholder shape the header
  -- argues against at length.
  placed_at  TEXT NOT NULL,

  -- The resume. All three are written by one conditional UPDATE in `src/butler/pause-acts.ts`, so a row with
  -- some and not the others is one no path in this Node produces.
  --
  -- `resumed_reason` is **mandatory in the write path**, which inverts `domain_pauses.lifted_reason` — and the
  -- inversion has the same premise as #66's own inversion of #64. A domain pause was placed by two people who
  -- wrote down why, so lifting needs no second justification and delay is the harm to avoid. A Butler pause
  -- was placed by a **machine**: there is no human judgement anywhere in its lifecycle except this one, so a
  -- resume with no stated reason would mean nobody recorded a decision at any point. And the harm of a wrongly
  -- paused Butler is *stopped automation*, not stopped mail — the customer's message still arrives, is still
  -- visible in the mailbox, and a person can still answer it by hand — so ceremony here costs a delay in
  -- convenience rather than a delay in somebody's mail.
  --
  -- NOT NULL is not the way to say "mandatory" for a column that is NULL until the act happens, so the
  -- database holds nullability and `src/butler/pause-acts.ts` refuses `E_BUTLER_PAUSE_REASON_REQUIRED` on a
  -- blank or whitespace one — the same split 0026 makes on `domain_pauses.reason`.
  resumed_at     TEXT,
  resumed_by     TEXT,
  resumed_reason TEXT
);

-- At most one pause in force per Butler, and the read every trigger performs.
--
-- UNIQUE and partial, which does two jobs with one B-tree, exactly as `dpz_in_force` does: it is the index
-- `src/butler/pause.ts` probes — one seek on (org_id, butler_id) per published version considered — and it
-- makes "two pauses in force on one Butler" not representable. Two would need two resumes to restart one
-- Butler, and an administrator who resumed the one they could see would believe they had.
--
-- A Butler paused, resumed, and paused again has a representation without relaxing this: the resumed row falls
-- out of the index entirely, so a fresh row can be written. Same move 0021 made by giving a lift its own row.
CREATE UNIQUE INDEX bpz_in_force ON butler_pauses (org_id, butler_id) WHERE resumed_at IS NULL;

-- Every pause a Butler has ever had, in order, for `doctor` and for the resume path's refusals.
CREATE INDEX bpz_butler ON butler_pauses (org_id, butler_id, placed_at DESC);

-- ## The causal join needs this index, and the index is the evidence the join is possible at all
--
-- #66 said loop detection needed *"a per-run causal record"* and #75 asked whether the link from an inbound
-- message back to the send that provoked it exists in this schema. **It does**, and it was already complete
-- before this migration — found by reading the four columns rather than by assuming:
--
--   1. `send_manifests.rfc_message_id` is *"the Message-ID this Node authors"*, `snd_<ulid>@<sending domain>`,
--      and `renderRfc822` emits it verbatim as the `Message-ID:` header.
--   2. A replying agent that threads properly puts that value in `In-Reply-To:`.
--   3. `mime.ts`'s `messageIds` strips angle brackets on the way in — *"because that is the form these are
--      compared in"* — so `messages.in_reply_to` holds `snd_<ulid>@<domain>` with no brackets, and equality
--      against `rfc_message_id` is an equality on two values neither side reformats.
--   4. `butler_run_effects.subject` holds the manifest id of a `mail.send.propose`, and `run_id` names the run,
--      whose `butler_id` names the Butler.
--
-- So *"this inbound message is a reply to a send this Butler made"* is a join, not a fog. What it needs is a
-- way into `send_manifests` by the Message-ID a reply quotes, and 0007 indexed that table by thread parent,
-- by due date and by retry state — never by its own Message-ID, because until now nothing looked one up.
-- `msg_by_rfc_id` is the mirror of this on the inbound side and has existed since 0006.
--
-- **What the link cannot see is stated with it**, because an index makes a query fast and not correct: a reply
-- carrying no `In-Reply-To` at all, or one whose headers did not parse, has no link back — so the detector
-- built on this is blind to an unthreaded reply and to a third party that answers with a fresh message rather
-- than a reply. `docs/receipts/butler-pause.md` records that as the absence, and `doctor`'s
-- `butler_loop_detection` reports whether this Node is seeing threaded replies at all rather than reporting a
-- reassuring zero.
--
-- ## It leads on `rfc_message_id` and not on `org_id`, and that was found by a test rather than reasoned
--
-- Every other index in this schema starts with `org_id`. This one does not, for two reasons and the second is
-- the one that decided it.
--
-- The first is that `rfc_message_id` is `<manifest ULID>@<domain>`, so it is unique by construction and is the
-- selective column — the seek finds one row and reads `org_id` off it.
--
-- The second was measured. Written as `(org_id, rfc_message_id)` this index **displaced
-- `sm_evidence_changed`** in SQLite's planner for `doctor`'s evidence-mismatch check, which is partial on
-- `(org_id) WHERE state_reason = 'evidence_changed'`. The observed plan was
-- `SEARCH send_manifests USING INDEX sm_by_rfc_message_id (org_id=?) | USE TEMP B-TREE FOR ORDER BY` — a scan
-- of every manifest this Node has ever sealed, where the partial index is a seek into an empty B-tree on a
-- healthy Node. That is exactly the *"a check has become proportional to mailbox size"* failure
-- `doctor_cost`'s own `fix` names, and it arrived as a side effect of an index for something else.
-- `test/outbound-recheck.test.ts` reads the plan from the planner rather than trusting a comment, which is why
-- this was caught in the same change rather than six months later.
--
-- UNIQUE rather than plain, and that is a property rather than a spelling: two manifests claiming one
-- Message-ID would let one inbound reply attribute to two sends, and the loop count would then be over a
-- chain that never happened. `sealManifest` is the only writer and derives the value from a fresh ULID, so
-- this is a tripwire past where any correct code goes.
CREATE UNIQUE INDEX sm_by_rfc_message_id ON send_manifests (rfc_message_id);
