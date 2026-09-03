-- The Node's own Cloudflare grant (#162, ADR 42, ADR 28).
--
-- ## Why the Node holds a grant at all
--
-- ADR 42 struck provision-and-claim and dropped the bootstrap orchestrator with it, and what replaced them is
-- the Node as its own **private** OAuth client. A private client is authorizable only by members of the
-- account that created it — which is the customer — so no Mailda-operated service ever holds a Cloudflare
-- grant at any point. That is the only shape in which §1's promise that disconnecting Mailda stops nothing
-- needs no argument, because there was never anything to disconnect.
--
-- ## Two tables, because a flow in progress is not a binding
--
-- `provider_binding` is what this Node holds. `provider_authorizations` is a redirect in flight: a `state`
-- nonce and a PKCE verifier that exist between the browser leaving for Cloudflare and coming back, and are
-- worthless afterwards. Folding them into one row would make an interrupted consent indistinguishable from a
-- binding half-written, which is precisely the honest-state distinction #162 is about.
--
-- ## One row, and the CHECK is what makes that true
--
-- 0036's argument, unchanged and for a stronger reason. A Node is deployed *into* one Cloudflare account. Two
-- rows would be two answers to *whose account is this Node in*, resolved by whichever the query returned —
-- and unlike a transport credential, the wrong answer here names the account a plan would provision into.
CREATE TABLE provider_binding (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),

  -- ## The client half: what the operator created in the dashboard
  --
  -- The ceremony ADR 42 accepts and requires be *guided*. The operator creates an OAuth client and gives the
  -- Node two values; the Node prints the steps, the redirect URI and the scope list, and verifies the result.

  -- **Not a secret, and deliberately not treated as one.** A client id appears in every authorization URL by
  -- construction — #167's receipt quotes one — so wrapping it would buy nothing and would stop `doctor` and
  -- the ownership page naming which client this Node uses.
  client_id                TEXT NOT NULL,

  -- Wrapped by `wrapCredential`, so what is stored is `v<generation>.<base64>`. Never returned by any route:
  -- the surface reports *that* a client is registered and when, which is the whole question an operator has.
  --
  -- Cloudflare permits **two** secrets per client so one can be rotated before the old is deleted. This Node
  -- holds one at a time and re-registration replaces it, which is the same operation from the Node's side —
  -- recorded here so a reader meeting `has_rotated_secret` in Cloudflare's API knows it is not modelled.
  client_secret            TEXT NOT NULL,

  -- The redirect URI **as registered**, stored rather than recomputed from the request.
  --
  -- RFC 6749 requires the token exchange to send the same `redirect_uri` the authorization used, and a Node
  -- reachable on more than one hostname would otherwise compute a different one and be refused at the
  -- exchange — after consent, which is the worst place to discover a configuration mismatch. Storing what was
  -- registered also lets the Node show the operator the exact string to paste, and check the one it would send
  -- against it.
  redirect_uri             TEXT NOT NULL,

  registered_at            TEXT NOT NULL,

  -- **No `REFERENCES users (id)`, and every other attribution column in this schema agrees** — `placed_by`,
  -- `opened_by`, `created_by`, `published_by`, `configured_by`, none of them declare one.
  --
  -- The first draft of this migration did, and the cost was immediate and instructive: a foreign key here
  -- makes removing a person depend on this Node's *infrastructure history*, so deleting an account that once
  -- registered an OAuth client fails with `FOREIGN KEY constraint failed` — a database error, on a path about
  -- people, naming a table about Cloudflare. It broke sixty-three unrelated tests in one run.
  --
  -- The attribution is a historical fact and has to survive the account it names, which is the same reason
  -- audit entries record an actor id rather than joining to one.
  registered_by            TEXT NOT NULL,

  -- ## The grant half: null until an operator has consented
  --
  -- Every column below is nullable together. A client registered with no grant is `awaiting_consent`, which is
  -- a state an operator is *in* rather than a failure, and the reason these are not a second table is that
  -- there is exactly one grant per client and a join would let the two disagree about which client the grant
  -- belongs to.

  -- The account the operator **selected on the consent screen**, which is why it is not supplied with the
  -- client id. #162's own hardest state is that a consent screen may not list the account an operator means —
  -- an administrator can disable public OAuth app access — so which account was actually granted is a fact
  -- only the grant response can settle.
  account_id               TEXT,

  -- Both wrapped. The access token expires; the refresh token is the durable authority and is the thing a
  -- revocation in Cloudflare kills, which is what makes `grant_refused` observable at all.
  access_token             TEXT,
  refresh_token            TEXT,
  access_expires_at        TEXT,

  -- The scopes **as granted**, JSON, which may be a subset of those requested: Cloudflare permits optional
  -- scopes to be declined at consent. Stored as granted rather than as asked for, because a Node that recorded
  -- its request would report an authority it does not have — and the plan is built from what it can actually
  -- do.
  scopes_granted           TEXT,

  granted_at               TEXT,

  -- ## Two states that are not derivable from the columns above, and differ in who observed them

  -- **Observed.** Cloudflare rejected the stored grant — revoked in the dashboard, or a refresh token past its
  -- grant session. Recorded rather than inferred from a missing token, because the tokens are still here: the
  -- distinction between *never granted* and *granted and then refused* is the one an operator needs, and
  -- deleting the row on a refusal would erase it.
  refused_at               TEXT,
  refused_detail           TEXT,

  -- **Reported, not observed, and the column name says so.**
  --
  -- An account administrator can disable public OAuth app access under Manage Account → Members → Settings.
  -- The consequence is that the consent screen simply does not list the account the operator means, with no
  -- error and no response the Node ever sees — the authorization request never returns. So this state is
  -- unreachable by measurement and reachable only by an operator saying so.
  --
  -- A Node that inferred it from a consent that never came back would be guessing, and would say "your
  -- administrator has disabled OAuth apps" to an operator who simply closed the tab. The surface therefore
  -- offers it as something the operator asserts, and every place it is displayed says which of the two it is.
  unselectable_reported_at TEXT,
  unselectable_reported_by TEXT
);

-- A consent in flight. Rows here are worthless the moment they are used or expire, and a row is not a binding.
CREATE TABLE provider_authorizations (
  -- The `state` nonce, as sent. Not secret — it travels in the authorization URL and comes back in the query
  -- string — and its whole job is that a callback carrying a state this table does not hold is not a callback
  -- this Node started.
  --
  -- **At least 8 characters, enforced by Cloudflare and asserted by this Node before it builds the URL.**
  -- `cloudflare-oauth-node-as-client.md` measured it: a shorter state is answered with `error=invalid_state`
  -- and a message about entropy, which does not read like a configuration problem to whoever meets it.
  state                    TEXT PRIMARY KEY CHECK (length(state) >= 8),

  -- Wrapped, though it is single-use and short-lived. PKCE's verifier plus an intercepted code is an exchange,
  -- and the argument that the client secret is also needed is an argument about *another* secret's safety
  -- rather than about this one's. One Durable Object round trip on a once-per-connection path.
  code_verifier            TEXT NOT NULL,

  -- What was asked for, JSON. Kept so the callback can report the difference between requested and granted
  -- rather than only the result — a declined optional scope is a fact about the consent, not a fault.
  requested_scopes         TEXT NOT NULL,

  started_at               TEXT NOT NULL,
  -- Not a foreign key, for the reason `registered_by` above gives at length.
  started_by               TEXT NOT NULL,

  -- A consent nobody completes leaves a row, and a row with a verifier in it should not live indefinitely.
  -- Compared at the callback rather than swept: a sweep is a scheduled job for one row of one table, and an
  -- expired state that is refused at the callback is already the behaviour that matters.
  expires_at               TEXT NOT NULL,

  -- Single use. Set in the same statement that consumes it, so a code replayed against a state already spent
  -- is refused by the row rather than by a check somewhere in the handler.
  consumed_at              TEXT
);
