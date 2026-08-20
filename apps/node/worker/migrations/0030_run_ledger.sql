-- The run ledger and the four replay modes (#53, Layer 4, blueprint 16). Additive (#10 expand/contract): four
-- columns and two partial indexes, no DROP, no rewrite of an existing table, so no bookmark gate.
--
-- ## There is no new table here, and that is the finding rather than an economy
--
-- 0028 named this seam — *"a ledger is additive over these two tables, keyed on `butler_runs.id`"* — and #53's
-- resolution was written before the seam existed, so it proposed `workflow_runs`, `step_runs` and
-- `action_intents` from the blueprint's 12. Three of those are now the two tables 0028 shipped, under names an
-- operator already reads in `GET /api/butler-runs`, and a second set beside them would be two accounts of one
-- run that can disagree. What #53 actually asks for is the **provenance** those tables cannot carry: what the
-- run was given, whether it is a replay of another run, and who asked for it. That is four columns.
--
-- What is deliberately still not recorded is a row per **step**. 0028's argument holds unchanged: a run's pure
-- nodes perform no I/O and are 0 in `butler-step-cost.md`, so a row each would be storage bought for
-- arithmetic nobody can be asked about. `inspect` therefore reads the frozen `ast_json` and the recorded
-- effects and says plainly that the nodes between them were not recorded — see `src/butler/replay.ts`.

-- What the run was given: the `event.*` root of its state, as the trigger assembled it.
--
-- **This is the one thing `inspect` needed and could not have.** A run's program is frozen on
-- `butler_versions` (#49) and its effects are in `butler_run_effects`, but its *input* lived only in the
-- Workflow instance's params — and `workflow-provisioning.md` measured instance state as retained 3 days on
-- Workers Free and 30 on Paid. So `inspect` of a five-week-old run could show the program and the outcome and
-- not what the run saw, which is the one of the three a reader needs to understand the other two.
--
-- **Not re-derivable, which is why it is stored rather than computed.** `deliveryFacts` would answer from
-- permanent tables, and it would answer about **now**: `case_id` is a LEFT JOIN against a case that may have
-- been created after the run, `conversation_id` moves when two conversations are merged, and the
-- address-to-mailbox join changes when an address is re-routed. A replay driven by re-derived facts would be a
-- run of the same program over different input, which is not a replay of anything.
--
-- NULL means **recorded before this migration**, which is a real and distinguishable answer rather than a
-- placeholder: `inspect` says the facts were not recorded, and `re-run` refuses rather than inventing them.
-- Every run opened after this writes it, so the column is never uniformly NULL — the shape
-- `test/node/placeholder-columns.test.ts` exists to catch.
ALTER TABLE butler_runs ADD COLUMN trigger_facts TEXT;

-- The run this one replays, and the person who asked for it. Both NULL on an ordinary run, and that is a
-- value rather than an absence: a run caused by a delivery is nobody's act, which is exactly the argument
-- `src/audit.ts` makes for there being no `butler.ran` action.
--
-- **A replay's own id is `<butler_version_id>-<replay_id>`**, not `<butler_version_id>-<trigger_key>`. It has
-- to be: 0028 made the instance id the primary key precisely so one delivery cannot produce two records of one
-- version, and a replay of that delivery would collide with the record it is replaying. So the second half
-- becomes the replay's own `brp_` ULID — the same shape (`<version>-<what made this run happen>`), the same
-- length to the character (30 + 1 + 30 = 61 against `workflow.instance_id_max_chars = 100`), and the delivery
-- is still on the row in `trigger_key` and still indexed by `brn_by_trigger`.
--
-- That is also what keeps ADR 9's distinction intact: the id dedups the **intent**, and for a replay the
-- intent is a person's decision rather than a delivery. Two clicks are two intents and therefore two runs —
-- and what stops the second one sending a second copy of the same mail is not the id, it is the content rule
-- in `src/outbound/manifest.ts`.
ALTER TABLE butler_runs ADD COLUMN replay_of TEXT;
ALTER TABLE butler_runs ADD COLUMN replayed_by TEXT;

-- "Every replay of this run", which is the question `inspect` asks and the one a reader of a run asks next.
-- Partial, because on any Node the overwhelming majority of runs are not replays and an index over their
-- NULLs would be the whole table again.
CREATE INDEX brn_by_replay_of ON butler_runs (org_id, replay_of) WHERE replay_of IS NOT NULL;

-- The send this one deliberately repeats, for `resend-may-duplicate` and for nothing else.
--
-- The unprovable sibling of `retry-effect` mints a **new** effect key on purpose (ADR 9, ADR 35): the old key
-- may already have been handed over, so reusing it would claim these are the same effect when the whole point
-- of the mode is that nobody can say. A new key makes them two effects, and this column is what says the
-- second is the first one again rather than an unrelated message that happens to read alike.
--
-- Never written by `retry-effect`, which reuses the old manifest and mints nothing, and never written by a
-- Butler replay: a `re-run` whose content is identical **reuses** the old key and seals nothing at all.
ALTER TABLE send_manifests ADD COLUMN resend_of TEXT;

-- "Was this send repeated, and as what". Partial for the same reason as above: a resend is a rare, deliberate,
-- human act, and an index over every send that is not one is the table.
CREATE INDEX snd_by_resend_of ON send_manifests (org_id, resend_of) WHERE resend_of IS NOT NULL;

-- ## What this migration deliberately does not add
--
-- **A content hash column on `send_manifests`.** #53 decides *materially new* by content — the normalized
-- body's SHA-256 plus the envelope — and the tempting shape was a stored `content_sha256` with an index. It is
-- not stored, because it is **derivable from columns that already exist**: `body_normalized_sha256` is one of
-- the three hashes `sealManifest` already computes, and the envelope is `envelope_from`, `envelope_to`,
-- `envelope_cc`, `envelope_bcc`, `subject` and `in_reply_to_message_id`. `contentIdentity` in
-- `src/outbound/manifest.ts` is the one implementation, used both to hash the send a replay is *about* to make
-- and to hash the send it might be repeating.
--
-- Deriving it rather than storing it is not only cheaper. A stored column would be NULL for every manifest
-- sealed before today, and a NULL that cannot match is the **permissive** failure here: a replay would call a
-- byte-identical send materially new, mint a fresh key and hand the same message over twice, which is exactly
-- what 16's sentence exists to prevent. Derived, the rule works on every manifest this Node has ever sealed.
--
-- **A uniqueness constraint on content.** Rejected in #53's resolution and worth repeating where somebody
-- might add one: *"please resend that"* is a legitimate request, and `resend_of` above is how it is
-- represented. The content rule is scoped to a replay of a run — a repetition of a **program** — and never to
-- a person composing the same words twice.
--
-- ## Retention is still fog, and is named rather than defaulted
--
-- #53's resolution left it open and it stays open: audit entries are never trimmed, `log_entries` are bounded,
-- and a run ledger is neither. What this migration changes about that question is only its size — four columns
-- on rows that already exist, plus `trigger_facts`, which is the one that grows a row measurably. The honest
-- answer needs `audit-and-log-retention.md`'s row-size arithmetic against D1's 10 GB per-database ceiling, and
-- nothing here pretends to have done it.
