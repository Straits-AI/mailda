-- Passkeys (#84, ADR 29, §5A).
--
-- ## The decision this closes, and which way round it was
--
-- ADR 29 locks *"passkeys are the authentication Mailda builds; password authentication survives as a
-- per-user fallback."* It shipped **inverted**: passwords were the only authentication, and every reference
-- to passkeys in the tree was prose. `src/claim.ts` said so outright, which is the honest treatment of a
-- deferral and is also the evidence that the contract's primary mechanism was never started.
--
-- It mattered more than when it was written. #83 made a Node able to add people, so a password stopped being
-- one operator's own credential on their own Node and became **every colleague's**, on a system holding an
-- organization's mail. `password-hash-cost.md` had already said what that costs: PBKDF2 at 600,000 effective
-- iterations is *"an accepted baseline, not a strong one"*, reached by chaining six rounds because Workers
-- caps a single call at 100,000. The README calls passwords the weakest part of the design **deliberately**,
-- and the word doing the work there is only true while the stronger mechanism is on its way.
--
-- ## What is stored, and what is deliberately not
--
-- Nothing replayable. A passkey's private half never leaves the authenticator, and this table holds the
-- public half plus the bookkeeping the spec requires. A dump of this table lets an attacker *verify*
-- signatures, which is what verification is; it lets them forge nothing.
CREATE TABLE credentials (
  -- The authenticator's own credential id, base64url. Primary key rather than a minted `crd_` id: WebAuthn
  -- hands this back on every assertion and it is what an authentication looks the row up by, so a second
  -- identifier would be a second thing to join on and a chance for the two to disagree.
  id                TEXT PRIMARY KEY,

  user_id           TEXT NOT NULL,
  org_id            TEXT NOT NULL,

  -- The COSE public key, base64url. Public by construction — the name is the property.
  public_key        TEXT NOT NULL,

  /*
   * The authenticator's signature counter.
   *
   * Required by the spec as a **clone detector**: a counter that goes backwards means two authenticators are
   * answering for one credential, which is the signature of a copied key. Many modern authenticators —
   * notably platform passkeys that sync — report a constant 0, and that is legitimate; the check is
   * therefore "never decreases" rather than "always increases", and `src/auth/passkey.ts` carries the
   * argument for why the weaker form is the correct one rather than a concession.
   */
  sign_count        INTEGER NOT NULL DEFAULT 0,

  -- How the browser said it reached this authenticator (`internal`, `usb`, `hybrid`…), JSON. Advisory only:
  -- passed back in a later challenge so a browser can prompt for the right device. Never a decision input.
  transports        TEXT,

  -- What the person called it. Theirs, not the authenticator's: "work laptop" is what makes a list of
  -- credentials revocable by somebody who has forgotten which is which.
  label             TEXT NOT NULL,

  created_at        TEXT NOT NULL,
  -- NULL until first used. What makes "this one has never signed you in" answerable, which is the question
  -- somebody deciding whether to delete a credential actually has.
  last_used_at      TEXT
);

-- Every credential a person holds, for the list and for the bound. Not UNIQUE: one person, many devices, and
-- that plurality is the entire point of the format.
CREATE INDEX crd_by_user ON credentials (org_id, user_id);

-- ## Challenges are server-issued, single-use and short-lived
--
-- The challenge is the anti-replay device of the whole ceremony, and its properties come from *where it is
-- stored* rather than from what it contains. A challenge the client chose is no challenge at all; a
-- challenge this Node minted and does not delete is a replay window.
--
-- So: minted here, spent here, and deleted in the same statement list that consumes it. `expires_at` is the
-- second lock for the ones nobody ever comes back for — a ceremony somebody abandoned leaves a row, and
-- without an expiry the table only grows.
CREATE TABLE webauthn_challenges (
  -- The challenge bytes themselves, base64url. Primary key because looking one up *is* the check: a
  -- challenge the client returns that is not a row here was not issued by this Node.
  challenge   TEXT PRIMARY KEY,

  -- `register` or `authenticate`. A challenge issued for one ceremony must not be spendable in the other:
  -- without this, a registration challenge — which an unauthenticated caller can be given — would be
  -- redeemable as an authentication.
  purpose     TEXT NOT NULL CHECK (purpose IN ('register', 'authenticate')),

  -- Who it was issued to, for a registration. NULL for an authentication, where the whole point is that the
  -- caller has not said who they are yet and the credential id will answer it.
  user_id     TEXT,
  org_id      TEXT,

  created_at  TEXT NOT NULL,
  -- Sized rather than measured: `auth.passkey_challenge_ttl_seconds`, argued in `passkey-verification.md`.
  -- Stored per row rather than computed from `created_at` at read time, so changing the budget cannot
  -- silently extend challenges that were already issued — the same reason `invitations.expires_at` is a
  -- column.
  expires_at  TEXT NOT NULL
);

-- The sweep: expired challenges are deleted whenever a new one is minted, which is the only moment this
-- table is written and therefore the cheapest place to keep it bounded. No cron, because a table nobody
-- reads while it is stale costs nothing but bytes.
CREATE INDEX wac_expiry ON webauthn_challenges (expires_at);
