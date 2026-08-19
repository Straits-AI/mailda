-- The policy object (#60, Layer 5, blueprint 18). Additive (#10 expand/contract): two new tables and
-- four new columns, no DROP and no rewrite of an existing one, so no bookmark gate.
--
-- ## Five conditions, five columns, and deliberately no JSON blob
--
-- Blueprint 18 lists thirteen policy dimensions. #60 ships **five**, and the five are exactly the ones
-- answerable from a column that exists or from one derivation over storage that exists:
--
--   mailbox              send_manifests.mailbox_id
--   actor                send_manifests.author_user_id
--   recipient_external   the recipient domain is not among the domains appearing in addresses
--   is_reply             send_manifests.in_reply_to_message_id IS NOT NULL
--   org_daily_volume     send_counters.handed_over, which is org-wide and daily
--
-- Every other dimension is **named absent with its reason** in src/policy.ts rather than stubbed, because a
-- condition backed by no data is a policy that silently never fires -- which reads as governance and is not.
--
-- So the conditions are five typed columns, one per condition, NULL meaning "this policy does not constrain
-- this". A JSON blob was rejected for two reasons and the second is the load-bearing one. It cannot be
-- indexed or type-checked, which is the ordinary objection. More importantly it would **admit a sixth
-- condition nothing evaluates**: a blob accepts any key, so a policy naming data_class or device would be
-- storable, publishable and silently inert. Five columns make an unimplemented dimension a schema error at
-- the moment somebody tries to express it, which is the failure #60's own principle asks for.
--
-- ## What the matching query can and cannot do, stated rather than implied
--
-- Every condition is a column, so the whole predicate is expressible in SQL:
--
--   AND (when_mailbox_id IS NULL OR when_mailbox_id = ?)  ... and so on for the other four
--
-- src/policy.ts deliberately does **not** push it down, and the reason is cost rather than taste. Two of the
-- five conditions are *derived* -- recipient_external needs the domain set, org_daily_volume needs today's
-- counter -- so a SQL predicate would have to bind both inputs on every evaluation, spending two queries
-- whether or not any live policy asks for them. Reading the candidate rows first lets those two inputs be
-- fetched only when some published policy actually constrains them, which is the difference between one
-- query and three per seal (receipt: policy-evaluation-cost.md, measured). The row has to be read anyway,
-- because the decision must name *which* policy matched.
--
-- What that costs, said plainly: the number of published policies per organization is read in full on every
-- seal. That is bounded by what a human writes, and it is the figure to watch -- if an organization ever
-- carries hundreds of published policies, the predicate moves into SQL and the two derived inputs become
-- unconditional. The index below is what makes reading them cheap; nothing here indexes a *condition*.

-- A policy: a name, and a history of versions. The name is the durable identity; the versions carry the
-- rules. Same split #49 chose for a Butler and its versions, reused rather than re-derived.
CREATE TABLE policies (
  id         TEXT PRIMARY KEY,   -- pol_<ulid>
  org_id     TEXT NOT NULL,
  name       TEXT NOT NULL,

  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- One policy per name per organization. A second policy called "no external replies" is either a duplicate
-- somebody forgot about or an edit they meant to make to the first; both are better refused than stored.
CREATE UNIQUE INDEX pol_name ON policies (org_id, name);

-- A version of a policy. Publication is the versioning event (#49, inherited wholesale): a published
-- version freezes, editing produces a draft, and a publish that changes nothing is refused.
--
-- ## Three lifecycle states, and what "freezes" means precisely
--
--   draft        editable. Not consulted by evaluation, ever. At most one per policy.
--   published    the current rule. Exactly the set evaluation reads.
--   superseded   frozen history. Still readable, because a send binds the version it was decided under.
--
-- Publishing a new version moves the previous one from published to superseded, which is an UPDATE of a
-- published row -- so "freezes" has to be exact rather than slogan. What freezes is the **content**: the
-- outcome, the five conditions and canonical_sha256 are never written again after the row is inserted.
-- The lifecycle state is a fact about the *set*, not about the rule, and it is the only column that moves.
-- test/policy.test.ts asserts the content bytes of a superseded version are byte-identical to what was
-- published, which is what makes the sentence above an enforced claim rather than a comment.
CREATE TABLE policy_versions (
  id              TEXT PRIMARY KEY,  -- plv_<ulid>
  org_id          TEXT NOT NULL,
  policy_id       TEXT NOT NULL,

  -- NULL while a draft. A draft is not a version -- publication is what mints one (#49) -- and a
  -- placeholder 0 would make "version 0" a thing readers have to be told does not exist.
  version         INTEGER,
  state           TEXT NOT NULL,     -- draft | published | superseded

  -- allow | hold | require_approval | deny, totally ordered in that direction (#60). No priority column:
  -- a priority lets a narrow allow beat a broad deny, which is how a policy system fails open, and it makes
  -- "why was this allowed" unanswerable from one row. Conflict resolution is max() over the matches.
  outcome         TEXT NOT NULL,

  -- The five conditions. NULL means unconstrained, so a policy with all five NULL applies to every send --
  -- which is the honest way to write an organization-wide rule and needs no separate "applies to all" flag.
  when_mailbox_id             TEXT,
  when_actor_user_id          TEXT,
  -- 0 or 1. Exact rather than heuristic for a **platform** reason: Email Routing only accepts addresses on
  -- domains in the customer's own Cloudflare account, so every domain appearing in addresses is a domain
  -- the customer controls. That argument rests on a property of Cloudflare rather than of this schema,
  -- which is why it is a stale_when clause in docs/receipts/policy-evaluation-cost.md and not just a
  -- comment.
  when_recipient_external     INTEGER,
  when_is_reply               INTEGER,
  -- Matches when today's org-wide handed_over count is at or above this. org-wide and daily because that is
  -- all send_counters is: org_id, day, handed_over. Per-mailbox, per-user, per-Butler and per-domain volume
  -- do not exist and are named absent in src/policy.ts rather than added here -- widening the counters is
  -- #66's subject, and its write-contention question belongs there.
  when_org_daily_volume_min   INTEGER,

  -- SHA-256 over the canonical serialization of outcome plus the five conditions, in a fixed field order.
  -- This is what makes "a publish that changes nothing is refused" reliable: ADR 35 already mints the send
  -- manifest id from canonical output, and the same discipline is reused rather than re-derived (#49).
  canonical_sha256 TEXT NOT NULL,

  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  published_by    TEXT,              -- NULL while a draft
  published_at    TEXT,              -- NULL while a draft
  superseded_at   TEXT               -- NULL until a later version replaces this one
);

-- The evaluation query's index, and the only index this table needs.
--
-- Partial on the published state, which is the shape #11 established for the authorization path: a
-- superseded version falls out of the index entirely, so the index holds exactly the candidate set --
-- one row per live policy -- rather than the whole history. Drafts fall out too, which is the property
-- that makes "a draft is never consulted" cheap as well as true.
--
-- No condition column is indexed, deliberately. The conditions are not filtered in SQL (see the header),
-- and an index on a column nothing selects on is a cost with no reader.
CREATE INDEX pv_live ON policy_versions (org_id) WHERE state = 'published';

-- One version number per policy. The conflict is the signal (#9): two concurrent publishes cannot both
-- take version 3, so one loses at the database and re-reads rather than minting a duplicate.
CREATE UNIQUE INDEX pv_version ON policy_versions (policy_id, version);

-- At most one draft per policy. Editing a published policy produces *the* draft, not another one, so an
-- author cannot accumulate three competing unpublished edits with nothing saying which is next.
CREATE UNIQUE INDEX pv_one_draft ON policy_versions (policy_id) WHERE state = 'draft';

-- The manifest's history of versions, for the "which rule applied" question the audit trail has to answer.
CREATE INDEX pv_by_policy ON policy_versions (org_id, policy_id, version);

-- ## What the manifest binds
--
-- An in-flight send binds the version set it was evaluated under, because blueprint 18's envelope requires
-- a policy version and result. The *decision* at dispatch uses the **current** policy -- that is what
-- honours 18's "stricter policy fails closed" -- and stricter is computable rather than a judgement
-- because the outcomes are totally ordered: max(current) > max(bound). #62 owns that recheck.
ALTER TABLE send_manifests ADD COLUMN policy_outcome TEXT;
ALTER TABLE send_manifests ADD COLUMN policy_versions TEXT;
ALTER TABLE send_manifests ADD COLUMN state_reason TEXT;

-- Three notes on those three columns, each of which a reader would otherwise have to guess at.
--
-- **policy_outcome is nullable and NULL means "not evaluated".** Every row sealed before this migration was
-- sealed with no policy plane at all, and a NOT NULL DEFAULT 'allow' would claim those sends were evaluated
-- and permitted -- a false statement about the past, written by a migration. So NULL is a distinct third
-- answer, and #62's stricter-than comparison has to treat an unevaluated bound as the weakest possible one
-- (allow), which fails closed: any current outcome above allow then reads as stricter. Stated here rather
-- than built here, because the recheck is #62's.
--
-- **policy_versions is a JSON array of plv_ ids, and this is the one place a blob is the right answer.** It
-- is a *record*, not a condition: nothing matches on it, nothing indexes it, and it is read only to answer
-- "which rule applied to this send". envelope_to on this same table is a JSON array for the identical
-- reason. The blob the header above rejects is on the other side of the relationship -- the conditions a
-- policy is matched by -- and that side has no blob at all. An empty array is a real answer: it means the
-- send was evaluated and no policy matched, which is why the default outcome is allow.
--
-- **state_reason is the machine token behind a state, distinct from last_error's prose.** #62 established
-- the convention that gates are awaiting-plus-reason and refusals are withheld-plus-reason, so distinctness
-- lives in the reason rather than in five new states. This migration puts four values in it: policy_hold,
-- policy_approval_required and policy_denied from #60's own mapping, and authority_lost on the one
-- pre-existing writer of withheld (ADR 39's authority re-check), because a column that is NULL exactly
-- where the reason is known is the placeholder shape this repository keeps finding defects in. #62's
-- remaining five reasons -- approval_revoked, approver_ineligible, policy_stricter, approval_expired,
-- evidence_changed -- are that ticket's to add.
--
-- ## awaiting is a new send_manifests.state value
--
-- The column has a comment listing its states (0007_outbound.sql) and no CHECK constraint, so the
-- vocabulary lives in the comment, the SendState union in src/outbound/dispatch.ts, and SEND_STATES in
-- src/client/delivery.client.js. All three are extended in this change; 0007's and 0010's comments now
-- point here.
--
--   held        allow             sealed, undispatched, still cancellable
--   awaiting    hold              a gate somebody can clear, with the reason saying which gate
--   awaiting    require_approval  the stricter of the two gates: only an approval.decide holder clears it
--   withheld    deny             this Node declined; nobody cancelled it and the mail service was never asked
--
-- **deny maps to withheld rather than to awaiting**, and the argument is worth the three lines. #60's
-- resolution says "held if allow, awaiting otherwise" in one sentence and names only hold and
-- require_approval as awaiting in another. The loose sentence is the one to distrust: a denied send sitting
-- in awaiting is a send **nobody can ever clear** -- there is no act that resolves it -- so it would
-- accumulate forever and read as pending. withheld already means exactly the right thing and #62 and #66
-- both split on it.
