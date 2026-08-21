-- The REST send API's credentials (#86, ADR 33, ADR 22, ADR 28).
--
-- ## Why a table and not a binding
--
-- ADR 22 said every credential authorizing an external effect is a **Secrets Store** binding. This is the
-- first such credential this Node has ever held, so it is the first real test of that rule — and the rule
-- does not survive contact with ADR 24. `wrangler.jsonc` already records why: a `secrets_store_secrets`
-- block needs an account-specific `store_id` in committed config, which is exactly the byte-identical-fork
-- collision ADR 24 forbids, and measurement showed removing the id drops the binding **silently** rather
-- than relinking the way D1 and R2 do (`binding-relink-on-id-removal.md`).
--
-- ADR 28 already settled this for the encryption keys and its reasoning transfers whole: what ADR 22 was
-- actually buying is that *serializing `env` discloses nothing*, and that survives when the secret arrives
-- over RPC and through a decrypt at the point of use. So the token is **wrapped under the credential KEK**
-- and stored here.
--
-- `src/auth/kek.ts` needs no change to accept it, and its own header is why this is the right home rather
-- than a convenient one: *"the credential key protects things that mint or spend authority — token-signing
-- keys, **transport credentials**, model keys."* The seam was built for this and has never held one.
--
-- ## One row, and the CHECK is what makes that true
--
-- A Node sends as one Cloudflare account. Two rows would be two answers to *which account carries this
-- Node's mail*, resolved by whichever the query returned — the shape `btv_one_live` was written to stop one
-- layer along. `id = 1` with a CHECK is the cheapest form of that: an INSERT of a second row is refused by
-- the database rather than by a convention in the write path.
CREATE TABLE sending_transport (
  id            INTEGER PRIMARY KEY CHECK (id = 1),

  -- Not a secret, and deliberately beside the token rather than in `node_capabilities`. An account id with
  -- no token is a half-configured transport that would report itself available and refuse every send, so the
  -- two halves are one row and arrive in one statement.
  account_id    TEXT NOT NULL,

  -- Wrapped by `wrapCredential`, so what is stored is `v<generation>.<base64>` and a D1 dump discloses
  -- nothing. Never returned by any route: `GET /api/transport` reports *that* a token is configured and
  -- when, which is the whole question an operator has, and a route that could return it would make every
  -- administrator a holder of the account's sending authority.
  api_token     TEXT NOT NULL,

  configured_by TEXT NOT NULL,
  configured_at TEXT NOT NULL
);
