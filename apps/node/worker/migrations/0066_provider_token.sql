-- The Node's own Cloudflare credential is an API token (26 September 2026; ADR 42 reopened, ADR 28).
--
-- ## Why a token, and why a new table
--
-- 0053 gave the Node a private OAuth client: a client id and secret, a consent, an access token renewed
-- hourly from a refresh token, and five states to say where in that an operator was. The token replaces
-- all of it. Both cost the operator one act in Cloudflare's dashboard; the token has no state machine, no
-- renewal, no client, and one revocation list in the dashboard. The Node already holds a sending token the
-- same way (0036), so this is the second row of a shape that exists rather than a third shape.
--
-- A new table rather than columns on `provider_binding`, because that row's columns are the client's:
-- `client_id NOT NULL`, `client_secret NOT NULL`. A token has neither. The old table stays for now, unread;
-- a later contract-phase migration drops it, per `test/node/migration-phase-world.test.ts`'s rule that
-- expand and contract ship in different releases.
--
-- ## One row, and the CHECK is what makes that true
--
-- 0036's argument, unchanged. A Node is deployed *into* one Cloudflare account, and two rows would be two
-- answers to *whose account is this Node in*.
CREATE TABLE provider_token (
  id             INTEGER PRIMARY KEY CHECK (id = 1),

  -- Wrapped by `wrapCredential`, so what is stored is `v<generation>.<base64>` and a D1 dump discloses
  -- nothing without the credential key. Never returned by any route.
  token          TEXT NOT NULL,

  -- The one account the token can see, read from `GET /accounts` at registration and bound then. Not a
  -- secret. The boundary every zone read is kept inside (#165).
  account_id     TEXT NOT NULL,
  account_name   TEXT,

  -- When `GET /user/tokens/verify` last said `active`. The registration is the only time so far; a later
  -- doctor may re-verify and move it.
  verified_at    TEXT NOT NULL,

  registered_at  TEXT NOT NULL,
  -- No `REFERENCES users (id)`, for 0053's reason: removing a person must not depend on infrastructure history.
  registered_by  TEXT NOT NULL
);
