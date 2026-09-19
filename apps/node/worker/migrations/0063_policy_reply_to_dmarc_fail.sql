-- A sixth policy condition: the send is a reply to a message whose DMARC verdict was `fail` (#260).
--
-- The classic compromise shape is a reply: a forged invoice arrives, somebody answers it, and the answer
-- carries whatever the forger asked for. The receiving server's verdict is already on the message row
-- (0055), so the condition is answerable from a column, which is #60's rule for admitting one. NULL means
-- unconstrained, as for the other five.
ALTER TABLE policy_versions ADD COLUMN when_reply_to_dmarc_fail INTEGER;
