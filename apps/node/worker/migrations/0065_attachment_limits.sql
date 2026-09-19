-- Attachment limits a mailbox declares (#265): a size bound and an allowed-type list.
--
-- NULL is unbounded, which is what every mailbox ships with. A delivery over the bound, or carrying a
-- type outside the list, is held the way the two switches hold (0056, 0057): filed, no case, listed for an
-- administrator. A send from the mailbox that breaks its own limits is refused at the seal, by name.
-- `attachment_allowed_types` is a JSON array of lower-case extensions, bounded at the boundary.
ALTER TABLE mailboxes ADD COLUMN attachment_max_bytes INTEGER;
ALTER TABLE mailboxes ADD COLUMN attachment_allowed_types TEXT;
