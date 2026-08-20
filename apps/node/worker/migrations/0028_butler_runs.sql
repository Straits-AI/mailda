-- The run record: enough for a person to see that a Butler run happened and what it did (#50, Layer 4,
-- blueprint 16). Additive (#10 expand/contract): two new tables, no DROP, no rewrite of an existing one, so
-- no bookmark gate.
--
-- ## Why there is a D1 record at all, when the Workflow already has one
--
-- Because the Workflow's is not durable. `workflow-provisioning.md` measured instance state and logs as
-- retained **3 days on Workers Free and 30 on Paid**, so a Workflow instance is not a record — it is
-- execution state that expires. #50's resolution states the split and this migration is the D1 half of it:
-- **the Workflow owns execution, D1 owns the record**, and they are different things rather than two copies
-- of one. A ledger built as a view over instance state would have gone blank at 30 days for every send a
-- Butler has ever proposed.
--
-- ## What this is NOT, named so nobody builds it here by accident
--
-- **This is not the run ledger.** [The run ledger and the four replay modes](#53) owns that: the complete
-- provenance §16 asks for, and `inspect` / `simulate-recorded` / `rerun-current` / `retry-effect`. Nothing
-- here records a step's *inputs*, an LLM or connector output to replay against, or a cached step result —
-- and none of those columns exist, because a column whose only value is NULL is the placeholder shape
-- `test/node/placeholder-columns.test.ts` exists to catch. The seam is named rather than left implicit: a
-- ledger is additive over these two tables, keyed on `butler_runs.id`, and the replay modes are its
-- business.
--
-- What this owns is the smaller question, and it is the one an operator asks first: *did it run, what did it
-- do, and what refused it.*
--
-- ## The primary key is the Workflow instance id, and that is deliberate rather than lazy
--
-- #50 fixed the instance id at `<butlerVersion>-<triggerKey>`, so it is unique by construction, it is what
-- `wrangler workflows instances describe` addresses, and it is what `create({ id })` refuses a duplicate of.
-- Minting a second `btr_` id beside it would be two identities for one run, and every question would then
-- start with which one the asker meant.
--
-- It is **not** an ADR 9 effect key, and the distinction is the one #50 said must not be conflated: this
-- dedups the *trigger*, while every sending step still mints its own effect key (the manifest id, ADR 35).
-- One intent, one run, many effects. `butler_run_effects.subject` below is where those keys land.
--
-- The dedup window is **30 days**, being the instance retention — a property of the platform, not of this
-- design. After it, the same id becomes creatable again and this table's PRIMARY KEY is what refuses the
-- second row. So the two mechanisms are not redundant: the platform stops a second *run*, and this stops a
-- second *record* for ever.
CREATE TABLE butler_runs (
  -- `<butler_version_id>-<trigger_key>`, at most workflow.instance_id_max_chars = 100 characters.
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,

  -- Both, because they answer different questions. The Butler is the durable identity and the
  -- authorization subject (a tuple names the `btl_`); the version is the exact program that ran, which is
  -- what makes "which program did this" answerable from the row rather than from a timestamp comparison
  -- against `butler_versions.published_at`.
  butler_id      TEXT NOT NULL,
  version_id     TEXT NOT NULL,

  -- What fired it. `mail.received` is the only trigger that exists (#49: the other eight of blueprint 16's
  -- families are fog), and the column carries the event name anyway rather than being implied, for the
  -- reason 0021 gives about `subject_kind`: a kind the writer leaves out falls back on a default, and a
  -- default is not a classification.
  trigger_event  TEXT NOT NULL,
  -- The delivery this run is *about*: a `msg_<ulid>`. Also the second half of `id`, and stored separately
  -- because "every run caused by this message" is a question a person asks and splitting a primary key in
  -- SQL to answer it is how a query stops using an index.
  trigger_key    TEXT NOT NULL,

  --   running           the interpreter is walking the graph
  --   awaiting_release  parked on a human release for a send it proposed (step.waitForEvent)
  --   finished          the graph ran out of nodes
  --   stopped           a `stop` node ended it, with its reason
  --   refused           the run refused itself before performing any effect (see `outcome_reason`)
  --   failed            a fault: an expression that could not be resolved, a schema this engine cannot
  --                     honour, a loop over more items than its bound
  --
  -- `refused` and `failed` are separate states because the first is the system working and the second is a
  -- program that cannot run. Collapsing them would make "how often do Butlers break" unanswerable.
  state          TEXT NOT NULL,
  state_at       TEXT NOT NULL,
  -- Why, as a machine token. NULL while running and whenever the run simply ran out of nodes.
  outcome_reason TEXT,

  started_at     TEXT NOT NULL,
  finished_at    TEXT,             -- NULL until terminal

  -- Counts, so the common questions need no join. `effects` is how many rows this run has in
  -- `butler_run_effects` with outcome 'ok'; `refusals` is how many with 'refused'. Denormalised on purpose:
  -- an operator's first question is "is anything refusing my Butlers", and answering it per run out of a
  -- child table is a scan where this is an index read. They are written by the same statement that writes
  -- the terminal state, so they cannot describe a different set of rows than the ones committed.
  nodes_executed INTEGER NOT NULL,
  effects        INTEGER NOT NULL,
  refusals       INTEGER NOT NULL,

  -- What this run has spent from its Workflow instance's subrequest pot, accumulated across every
  -- invocation of it. **Not bookkeeping — it is the input to a live budget guard**, which is why it is a
  -- column rather than a log line.
  --
  -- A Workflow instance has one pot for the whole run (workflow.budget_unit_is_instance = 1, measured), and
  -- a run that empties it is **killed wherever it has got to**, after the effects it already performed.
  -- #54 refuses an unaffordable Butler at publication, and that refusal prices the *nodes*; the engine
  -- costs more than the sum of its nodes (it reads the program, records what it did, and reads back a draft
  -- before sending it), so publication-time arithmetic alone is not enough to promise a run finishes.
  -- `src/butler/interpret.ts` therefore meters itself with `src/cost-meter.ts` and stops **before** an
  -- effect it cannot afford, with `budget_exhausted` — which turns "died having sent 50 of 200" into a
  -- refusal a person can read.
  --
  -- Accumulated rather than per-invocation because the pot is per *instance*: a run that sleeps or parks
  -- resumes in a new invocation with a fresh meter, and whether the platform's pot resets with it is
  -- **unmeasured**. This column enforces the stricter of the two readings, which is the safe direction —
  -- over-counting refuses a run that would have fitted, under-counting kills one that had already sent
  -- mail. Written in the same `batch()` as the effect row that caused the spend, so it cannot describe a
  -- different set of effects than the ones committed.
  subrequests_spent INTEGER NOT NULL
);

-- The newest runs first, which is the only listing this table has. Partial on nothing: every run is worth
-- listing, and a run that is still `running` is the most interesting row in it.
CREATE INDEX brn_by_org ON butler_runs (org_id, started_at DESC);

-- "Every run of this Butler", across versions. The version is deliberately *not* in the prefix: an operator
-- asking about a Butler means the program, not one publication of it.
CREATE INDEX brn_by_butler ON butler_runs (org_id, butler_id, started_at DESC);

-- "Did this delivery start a run", which is what a reader of a message's history asks and what a redelivery
-- would otherwise be diagnosed by hand.
CREATE INDEX brn_by_trigger ON butler_runs (org_id, trigger_key);

-- One row per **effect**, and per **refused** effect. Not one row per step.
--
-- The distinction is the same per-act-versus-per-row boundary that exempts `send_recipients` from the audit
-- trail, applied to a table that has to stay small: a run's pure nodes — guard, switch, transform, validate,
-- join, the loops themselves — perform no I/O and are `0` in `butler-step-cost.md`, so a row for each would
-- be storage bought for arithmetic nobody can be asked about. What a person needs is what the run *did* to
-- the world and what stopped it, and that is bounded by the affordability checker: a Butler that cannot
-- afford its effects cannot be published at all (#54).
--
-- Every row is written **inside the same step as the effect it records**, so it is retried and cached with
-- it. That costs one subrequest per effect and it is why `butler-step-cost.md`'s figures are *bounds with
-- headroom* rather than measured equalities: `docs/receipts/butler-run-cost.md` measures each node with its
-- record row included and holds it inside the same bound. The alternative — batching every row at the end
-- of the run — is one subrequest for all of them and leaves a killed invocation with a record of nothing,
-- which is the state this table exists to prevent.
CREATE TABLE butler_run_effects (
  id         TEXT PRIMARY KEY,   -- bre_<ulid>
  org_id     TEXT NOT NULL,
  run_id     TEXT NOT NULL,

  -- Position within the run, from 1. Not a timestamp: two effects inside one loop iteration can share a
  -- millisecond, and an order a reader has to guess at is not an order.
  seq        INTEGER NOT NULL,

  -- Which node, and what kind. The type is stored rather than looked up from `ast_json`, because reading a
  -- run's history must not require parsing the program — and because a superseded version's AST is frozen
  -- but a *deleted* Butler's row is not indestructible (0027 says so plainly), so a run record that could
  -- only be read by joining to the program would go blank.
  node_id    TEXT NOT NULL,
  node_type  TEXT NOT NULL,

  --   ok        the effect happened
  --   refused   policy, a breaker, an approval that cannot be satisfied, a case somebody else holds, an
  --             authority this Butler does not hold. **The system working**, which is why it is not 'failed'
  --   failed    the effect was attempted and the operation errored
  outcome    TEXT NOT NULL,
  -- The machine token behind the outcome, or NULL when there is nothing to say.
  --
  -- Non-null on an `ok` row too, and that is deliberate rather than sloppy: a sealed send that is *gated* —
  -- by a policy, by an approval, or by #50's own human-release gate — is an effect that **happened** (a
  -- manifest exists, with an effect key) and mail that has **not** left. Recording that as `refused` would
  -- say this Node declined something it did not decline, and recording it as a bare `ok` would say a Butler
  -- sent mail that is sitting in a queue. So the outcome says what the effect did and the reason says what
  -- the world is waiting on.
  --
  -- Two families of token, distinguishable on sight, and both stable machine tokens: snake_case for a
  -- decision the engine took or a send state it read back (`case_held`, `butler_release_required`), and an
  -- `E_` code for a refusal that came back from the Layer 5 function it called (`E_SENDER_AMBIGUOUS`).
  -- `src/butler/effects.ts` declares the first family and `src/errors.ts`'s discipline owns the second.
  reason     TEXT,
  -- What the effect touched or produced: a `snd_` manifest id, a `dft_` draft id, a `cas_` case id. This is
  -- where an ADR 9 effect key lands — one run, many keys — and it is what joins a run to the outbox.
  subject    TEXT,

  at         TEXT NOT NULL
);

-- The run's own history, in order. UNIQUE so a replayed step cannot append a second row claiming the same
-- position: a Workflow step is retried, and #9's shape applies unchanged — the conflict is the signal.
CREATE UNIQUE INDEX bre_by_run ON butler_run_effects (run_id, seq);

-- "What did Butlers do to this send / this case", from the other end. The join every outbox reader wants
-- when a manifest's author is a `btl_` rather than a person.
CREATE INDEX bre_by_subject ON butler_run_effects (org_id, subject);

-- ## Deletion is deliberately not prevented, and neither table is frozen by a trigger
--
-- 0027 argues this at length for `butler_versions` and the argument transfers without change:
-- immutability and indestructibility are different properties, retention in this product runs through legal
-- hold and the closed world in `test/node/content-deletion-world.test.ts`, and a `BEFORE DELETE` trigger
-- fails AGENTS.md's own test for a tripwire because an organization-deletion path is a good widget that
-- would hit it for ever with no override.
--
-- What is different here, and worth saying rather than inheriting: these rows are **not frozen** either.
-- `butler_runs.state`, `state_at`, `outcome_reason`, `finished_at` and the three counts are written again as
-- the run proceeds — that is the point of a run record — so there is no `btv_frozen` equivalent to write.
-- `butler_run_effects` rows are append-only *by discipline*: nothing in this Worker updates one, and
-- nothing prevents it. Said plainly because the alternative is a comment implying a guarantee no trigger
-- provides.
