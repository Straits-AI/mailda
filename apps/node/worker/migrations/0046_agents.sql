-- A delegated agent principal (#109 L2). Additive: two tables, no DROP.
--
-- ## What an agent is, and what it deliberately is not
--
-- A machine caller with an identity of its own. It is **not** an AI capability: whether the thing holding the
-- credential is a language model, a script or somebody's cron job is outside this. Conflating the two is how
-- "agent-native" becomes a claim about intent.
--
-- ## Three terms bound its authority, and only one of them is new here
--
--     effective(agent) = pinned action ceiling  ∩  live tuples of the agent  ∩  live tuples of the sponsor
--
-- The second and third terms are `relationship_tuples` with the agent as subject and `butler/authority.ts`'s
-- existing intersection, reused rather than reimplemented -- a second intersection that disagreed with the
-- first is the divergence `original-bytes-world.test.ts` exists because of. That is also why there is no
-- table of mailboxes here: an agent's resource ceiling **is** its tuples, granted by an administrator through
-- the same door as every other relation.
--
-- `agent_actions` is the first term and the only new mechanism: the set of capabilities pinned at mint. §16
-- requires a published Butler's ceiling to be computed at publication so that "new grants do not silently
-- expand" it, and an agent gets the same property for the same reason.
--
-- ## The token is opaque and hashed, not a signature
--
-- ADR 27 puts authority in a short-lived signature and revocation in the database, which is right for a human
-- session with a refresh. An agent has **no refresh** by decision -- a refreshable agent token is a permanent
-- one with extra steps -- so the credential is long-lived, and a long-lived signature cannot be withdrawn
-- before it expires. An opaque secret checked against a stored hash makes revocation a column and expiry a
-- comparison, which is what a credential a machine holds for weeks actually needs.
--
-- SHA-256, no expensive KDF, for the reason ADR 29 gives about recovery codes: the secret is not
-- human-chosen, so there is no offline-guessing surface to price.
CREATE TABLE agents (
  id              TEXT PRIMARY KEY,        -- agt_<ulid>; the audit actor, and a relationship_tuples subject
  org_id          TEXT NOT NULL,
  name            TEXT NOT NULL,           -- so a refusal and a trail entry can say which agent
  -- Whose authority this borrows. The third term of the intersection above, and the `delegator_user_id` every
  -- act it performs records (0045).
  sponsor_user_id TEXT NOT NULL,
  -- Who created it. An administrator (§28), and not necessarily the sponsor -- separating the two is what
  -- keeps minting a governed act rather than a personal convenience.
  created_by      TEXT NOT NULL,
  token_hash      TEXT NOT NULL,           -- SHA-256 hex of the opaque token. The token itself is never here.
  created_at      TEXT NOT NULL,
  -- Hard, and there is no refresh. Re-minting is the renewal, which means an expiring agent is a decision
  -- somebody makes again rather than one that renews itself in the dark.
  expires_at      TEXT NOT NULL,
  revoked_at      TEXT
);

CREATE UNIQUE INDEX agt_token ON agents (token_hash);
CREATE INDEX agt_by_org ON agents (org_id, revoked_at);
CREATE INDEX agt_by_sponsor ON agents (org_id, sponsor_user_id);

-- The pinned action ceiling: one row per capability this agent may ever exercise.
--
-- A closed set rather than a JSON column, so an unknown action is a row that cannot be inserted rather than a
-- string nobody validated -- the same argument `policy_conditions` makes. The actions are route names from the
-- machine surface (`packages/contract/src/agent.ts`), which is the vocabulary the caller already speaks.
CREATE TABLE agent_actions (
  agent_id TEXT NOT NULL,
  action   TEXT NOT NULL,                  -- "GET /api/messages", as the agent capability list names it
  PRIMARY KEY (agent_id, action)
);
