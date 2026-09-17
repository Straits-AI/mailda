-- What the receiving server established about each message's sender (mail security, deterministic half).
-- phase: expand
--
-- Cloudflare's MX writes an `Authentication-Results` header on every inbound message — SPF, DKIM, DMARC,
-- ARC — and until now this Node stored the bytes and read none of it. `src/authentication-results.ts`
-- parses the header bearing the receiving MX's own authserv-id (RFC 8601 §7.1: any other is untrusted)
-- and `materialise.ts` writes the verdict here as the row is created.
--
-- Every column is nullable, and NULL means one thing: **this message was materialised before the Node
-- evaluated authentication**, which is every message that predates this migration. It is not `absent` —
-- that is a word stored here when the header was looked for and not found — and it is not `none`, which is
-- a verdict. Three states, three spellings, because collapsing "nobody looked" into "nothing found" is how
-- an old message reads as clean.
--
-- Additive: five nullable columns, no index. The listing reads them by primary key alongside the rest of
-- the row, and nothing filters on them yet — a filter is a policy's question, and a policy needs an index
-- with a receipt behind it. Re-measured against real remote D1 before `message-metadata-bytes.md` moved.
ALTER TABLE messages ADD COLUMN auth_spf TEXT;
ALTER TABLE messages ADD COLUMN auth_dkim TEXT;
ALTER TABLE messages ADD COLUMN auth_dmarc TEXT;
ALTER TABLE messages ADD COLUMN auth_dmarc_policy TEXT;
ALTER TABLE messages ADD COLUMN auth_from_domain TEXT;
