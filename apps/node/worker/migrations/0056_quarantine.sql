-- Quarantine: a delivery held back from the queue because the sender's own domain disowned it.
-- phase: expand
--
-- 0055 stores what the receiving server established about a sender. This is the first thing the Node
-- *does* with it, and it does the narrowest honest thing: when a mailbox has asked for it, a message whose
-- DMARC failed against a domain that published `p=quarantine` or `p=reject` is filed — the evidence is
-- immutable and the row exists — but opens no case and sits in no queue until an administrator releases it.
-- A domain publishing `p=none` said "do nothing", and the Node does nothing; that is the domain's decision,
-- not this Node's to override.
--
-- Per delivery, on `messages`, because a `messages` row is one delivery (unique on its receipt) and the
-- listing already reads it. `quarantined_at` is the state; `quarantine_reason` is a token from the
-- contract's closed set (`dmarc_fail_reject` | `dmarc_fail_quarantine`), which the reading surface renders. Released is `quarantined_at` back to NULL, with the case created then — the same
-- `caseForDelivery` materialise would have run — so a released message is exactly what an unquarantined
-- one would have been, only later. Per mailbox, the switch, default off: turning it on is a decision about
-- whose mail a person will not see until somebody looks, and a default that makes it is a default nobody chose.
ALTER TABLE mailboxes ADD COLUMN quarantine_dmarc_fail INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN quarantined_at TEXT;
ALTER TABLE messages ADD COLUMN quarantine_reason TEXT;
