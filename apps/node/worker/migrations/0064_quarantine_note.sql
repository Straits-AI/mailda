-- A delivery held on request (#263): somebody, or somebody's agent, said why.
--
-- The two switches in 0056/0057 hold on a condition whose authority is the sender's own domain or the
-- bytes of an attachment, and the reason token says which. A hold asked for through the API carries a
-- reason in words, because the person releasing it has to know what the holder saw. The words are bounded
-- at the boundary and are never message content.
ALTER TABLE messages ADD COLUMN quarantine_note TEXT;
