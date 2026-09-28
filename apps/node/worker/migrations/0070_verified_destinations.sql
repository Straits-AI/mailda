-- Which of the addresses this Node has handed mail to were verified Email Routing destinations of its
-- Cloudflare account, and when (28 September 2026).
--
-- Cloudflare published no email.sending event for mail sent to a verified destination in the one case
-- measured (docs/receipts/email-sending-events.md). Such a recipient stays unobserved and reads exactly
-- like one whose answer is still coming, or like a Node whose subscription is missing. The list belongs
-- to the account and is read through the Cloudflare API by POST /api/provider/verified-destinations.
-- doctor makes no live call, so what a read found is recorded here with when it was true.
--
-- ## Only the intersection
--
-- The account's list can hold anybody's address: a forward to a family member, a colleague's inbox. A row
-- exists here only for an address send_recipients already holds as handed over. Storing it adds one fact
-- about an address this Node already had, and nothing about anybody else. The list enters SQL only as a
-- filter.
--
-- ## A fact about a time, not about an address
--
-- Whether a send went the verified-destination way depends on whether the address was verified when the
-- send was handed over. So each row keeps the interval a read proved: verified_from is Cloudflare's own
-- verified timestamp, and verified_until is the latest successful read that listed the address. A read
-- that no longer lists an address leaves its row alone, so hand-overs inside the proven interval stay
-- explained, and nothing after it is. Rows are never deleted. Every row names an address send_recipients
-- holds, and send_recipients rows are never deleted either; if they ever are, these go with them.
--
-- Additive (expand): two new tables the running Worker never names.
CREATE TABLE verified_destination_recipients (
  org_id          TEXT NOT NULL,
  -- lower() on both sides of the comparison: SQLite folds ASCII only, and so does the stored value.
  address         TEXT NOT NULL,
  -- Cloudflare's verified timestamp for this address, as the latest read that listed it gave it. A
  -- re-verification moves it later, which can only make fewer hand-overs count as explained.
  verified_from   TEXT NOT NULL,
  -- The latest successful read that listed the address as verified.
  verified_until  TEXT NOT NULL,
  PRIMARY KEY (org_id, address)
);

-- The read itself, one row, for provider_token's reason: a Node lives in one account. With it, "never read",
-- "read and found none" and "the last attempt failed" are three answers, where the table above alone
-- would give one empty table for all of them.
CREATE TABLE verified_destination_read (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  -- The account whose list read_at describes. NULL until a read succeeds; a failed attempt does not move it.
  account_id    TEXT,
  -- 'token' (this Node's stored API token) or 'operator' (wrangler's login carried on the request), for the
  -- latest attempt.
  authority     TEXT NOT NULL,
  -- The latest successful read, or NULL when none has succeeded. A failed attempt does not move it.
  read_at       TEXT,
  -- The latest attempt, whether it succeeded or not.
  attempted_at  TEXT NOT NULL,
  -- The latest attempt's failure as cloudflareGet reported it: Cloudflare's words when it gave any,
  -- otherwise http_<status> or "the Cloudflare API could not be reached". NULL when it succeeded. A failure
  -- means could not read, never none verified: the rows above stay as they were.
  error         TEXT
);
