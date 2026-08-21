-- Inviting a second person (#83).
--
-- Until now a Node had exactly one account — the one `claimNode` created — and nothing anywhere else wrote
-- to `users`. Layer 3 is *share*: cases, assignment, reply-collision, dual control, separation of duty. Every
-- one of those needs two people, and a Node had one. It also made several shipped refusals the *only*
-- reachable branch: `E_DOMAIN_PAUSE_UNSATISFIABLE`, `E_SUPERVISED_UNSATISFIABLE` and every hold lift need two
-- other people, so on a one-person Node they always refuse and the governance they protect is never exercised.
--
-- ## The shape is `node_claim`'s, deliberately
--
-- An administrator mints a secret and hands it over; the person redeems it by choosing their own password.
-- Only the **hash** is stored, so a lost invitation is re-minted rather than recovered — the same sentence
-- `mailda claim-secret` already prints, and the same mechanism, because a second way of doing this would be a
-- second thing to get wrong.
--
-- The property that matters is that **the administrator never learns the password**. The obvious alternative
-- — an administrator sets one and tells them — makes that administrator a permanent holder of every
-- colleague's credential, which is worse than the gap it fills. `set-password` already exists as the
-- deliberate operator escape hatch for a lockout, and it is loud about running outside the audit trail.
CREATE TABLE invitations (
  id               TEXT PRIMARY KEY,   -- inv_<ulid>
  org_id           TEXT NOT NULL,

  -- The address the invitation is *for*. Lower-cased on write by the caller, because `users.email` is and a
  -- comparison between the two decides whether an account already exists.
  email            TEXT NOT NULL,

  -- Only the hash. A secret this table could return is a secret a database read hands over, and the whole
  -- point of the mechanism is that it exists in one place for as long as it takes to paste it somewhere.
  secret_hash      TEXT NOT NULL,

  invited_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL,

  -- Sized rather than measured: `auth.invitation_expiry_seconds`, argued in `password-hash-cost.md`. An
  -- unredeemed invitation is a bearer credential for *membership*, so its lifetime is the window in which a
  -- leaked one is still useful. Stored per row rather than computed from `created_at` at read time, so
  -- changing the budget cannot silently extend invitations that were already out.
  expires_at       TEXT NOT NULL,

  -- NULL until somebody redeems it. The pair is written by one statement, so an invitation cannot be redeemed
  -- by nobody, and the row is kept afterwards: "this account exists because that administrator invited this
  -- address" is the only place that fact lives.
  redeemed_at      TEXT,
  redeemed_user_id TEXT
);

-- At most one open invitation per address. Minting a second while one is outstanding would put two live
-- bearer credentials for the same membership in circulation, and revoking the one you remembered would leave
-- the other working. Re-minting therefore has to withdraw the old one explicitly, which the write path does
-- in the same batch — and this index is what makes that a fact rather than a habit.
--
-- Partial on unredeemed, so the history of who was invited and when survives every redemption.
CREATE UNIQUE INDEX inv_one_open_per_email ON invitations (org_id, email) WHERE redeemed_at IS NULL;

-- The open set, for the screen that lists it. Partial for the reason every other partial index here is: a
-- redeemed invitation falls out entirely, so the index holds what is outstanding rather than the whole history.
CREATE INDEX inv_open ON invitations (org_id) WHERE redeemed_at IS NULL;

-- Redemption is looked up by the secret's hash and nothing else, so the read is one indexed probe rather than
-- a scan. UNIQUE because two invitations sharing a hash would mean two rows one secret could redeem, and the
-- resolution would be whichever the query happened to return.
CREATE UNIQUE INDEX inv_secret ON invitations (secret_hash);
