-- ADR 29's recovery codes, carrying ADR 28's key escrow (#92).
--
-- ## Why this table has to exist before anything else can be honest
--
-- `keyvault.ts` says of the Durable Object's storage: *"Lose it and every message is permanently
-- unreadable"*, and then: **"ADR 28 therefore does not ship without the key escrow in ADR 29."** That is a
-- release gate the code sets for itself. Three refusals already name the remedy — `E_VAULT_NO_KEY`,
-- `E_VAULT_UNKNOWN_GENERATION`, and doctor's `credential_key` finding all say *"restore the vault from the
-- ADR 29 recovery codes"* — and until this migration there were no recovery codes anywhere in the product.
-- An operator following that instruction had nothing to follow.
--
-- ## The escrow is wrapped under the code, not under its hash
--
-- Two different uses of one secret, and conflating them would make the escrow worthless:
--
--   * **Authentication** — is this a real code? Compared against `code_hash`, plain SHA-256. ADR 29's
--     reasoning holds: a 128-bit random code has no offline-guessing surface to price, so an expensive KDF
--     would buy nothing.
--   * **Encryption** — the escrow blob is sealed under a key derived from the code's **plaintext**, which
--     this Node never stores. If it were sealed under `code_hash`, then a D1 dump would carry both the
--     ciphertext and the key that opens it, and the escrow would protect against exactly nothing. The
--     operator holding the code is the whole mechanism.
--
-- So `code_hash` proves a code is one of the ten; the code itself opens the vault. This Node can verify a
-- code it cannot use.
--
-- ## Ten rows, ten wrapped copies
--
-- Each row carries its own copy of the wrapped vault secrets, because each code must independently open the
-- escrow — losing nine of ten is the ordinary case ADR 29's "ten single-use codes" anticipates, and a design
-- where the codes had to be combined would make nine losses fatal. The cost is ten AES-GCM blobs of a few
-- hundred bytes, which is nothing, against the alternative of a single point of loss.
--
-- `redeemed_at` makes them single-use, per ADR 29. Redemption is a conditional UPDATE on it still being
-- NULL, which is this repository's usual compare-and-swap: the conflict is the signal, and two concurrent
-- redemptions of one code cannot both succeed without a transaction D1 does not offer.
CREATE TABLE recovery_codes (
  id          TEXT PRIMARY KEY,               -- rcv_<ulid>
  org_id      TEXT NOT NULL,
  -- SHA-256 of the code, hex. Proves membership; does not open the escrow.
  code_hash   TEXT NOT NULL,
  -- The vault's secrets, AES-GCM under a key derived from this code's plaintext. Base64.
  escrow      TEXT NOT NULL,
  -- Which vault generations this blob carries, so a stale escrow is detectable rather than discovered
  -- during a restore. `doctor` reads it; see `recovery_escrow` there.
  content_generation    INTEGER NOT NULL,
  credential_generation INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  redeemed_at TEXT
);

-- One code is looked up by its hash at redemption, and the set is listed per organization to report how
-- many remain. Unique on the hash because two codes with one hash would make "single-use" ambiguous.
CREATE UNIQUE INDEX rcv_hash ON recovery_codes (org_id, code_hash);
CREATE INDEX rcv_unredeemed ON recovery_codes (org_id, redeemed_at);
