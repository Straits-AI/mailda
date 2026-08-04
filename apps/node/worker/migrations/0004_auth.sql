-- Email/password authentication with ES256 tokens and key rotation.
-- Additive (#10 expand/contract): no DROP, so no bookmark gate.

-- Password verifier. Never the password, and never a bare digest: PBKDF2-HMAC-SHA256 with a
-- per-user salt, iteration count recorded per row so the cost can be raised over time
-- without invalidating existing users.
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN password_salt TEXT;
ALTER TABLE users ADD COLUMN password_iterations INTEGER;
ALTER TABLE users ADD COLUMN password_updated_at TEXT;

-- Token signing keys. Several exist at once, which is what makes rotation non-disruptive:
-- one key signs, and every key still inside its verification window can verify.
--
-- The private key is stored wrapped, so a D1 dump alone cannot mint tokens. Public JWK is
-- plaintext by definition.
--
-- Wrapped by the *credential* KEK, not the content KEK. ADR 22 splits the two by purpose,
-- and a token-signing key is squarely a credential: it mints authority. Reaching for
-- CONTENT_KEK here would be convenient — it already exists — and would quietly undo that
-- split, so that one leaked KEK both reads mail and forges sessions.
CREATE TABLE signing_keys (
  kid              TEXT PRIMARY KEY,           -- key_<ulid>, travels in the JWT header
  algorithm        TEXT NOT NULL,              -- ES256
  public_jwk       TEXT NOT NULL,
  private_jwk_wrapped TEXT NOT NULL,           -- AES-GCM, framed, base64
  status           TEXT NOT NULL,              -- current | retiring | retired
  created_at       TEXT NOT NULL,
  retires_at       TEXT                        -- when it stops verifying; NULL while current
);
-- At most one current key. A partial unique index makes "two current keys" unrepresentable
-- rather than something a code path has to avoid.
CREATE UNIQUE INDEX sk_one_current ON signing_keys (status) WHERE status = 'current';
CREATE INDEX sk_verifiable ON signing_keys (status, retires_at);

-- Refresh tokens. This is where revocation lives, because §7 and §28 require authority to
-- disappear immediately and a signed access token cannot be recalled — so the access token
-- is short-lived and this is the thing that can be killed.
--
-- Rotating on use: each refresh mints a new token and marks the old one used. A second
-- presentation of a used token means the token was captured, so the whole family is revoked
-- rather than just refused.
--
-- Except for one case, which is why `replaced_by_wrapped` exists. If the client sent a
-- refresh and the *response* was lost — dropped connection, backgrounded tab, a second tab
-- racing the first — then the token is used but the client never received its successor. Bare
-- reuse detection reads that as theft and signs the user out for having flaky wifi. So for a
-- short replay window the successor is kept wrapped on the parent row and handed back
-- verbatim; after the window it is cleared and reuse means what it says.
--
-- The successor is wrapped under the credential KEK, so this window widens what a D1 dump
-- yields by exactly nothing.
CREATE TABLE refresh_tokens (
  id          TEXT PRIMARY KEY,                -- rft_<ulid>
  org_id      TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  family_id   TEXT NOT NULL,                   -- constant across a rotation chain
  token_hash  TEXT NOT NULL,
  used_at     TEXT,
  revoked_at  TEXT,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  replaced_by_wrapped TEXT                     -- successor, wrapped; cleared after the replay window
);
CREATE UNIQUE INDEX rt_token ON refresh_tokens (token_hash);
CREATE INDEX rt_family ON refresh_tokens (org_id, family_id);
CREATE INDEX rt_user ON refresh_tokens (org_id, user_id, revoked_at);

-- Failed sign-in attempts, so a slow lockout is possible without an in-memory counter that
-- a new isolate would forget.
CREATE TABLE login_attempts (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL,
  email      TEXT NOT NULL,
  at         TEXT NOT NULL
);
CREATE INDEX la_email_time ON login_attempts (org_id, email, at);
