-- Suppression: a recipient this Node will not send to again, and the one act that changes that.
-- phase: expand
--
-- There is no suppressions table, on purpose. The list is **derived** from `send_recipient_events`: an
-- address whose last word from the provider was a hard bounce (`bounce.type = "hard"`) or a complaint is
-- suppressed, and `sealManifest` refuses a composition naming it (`E_RECIPIENT_SUPPRESSED`). A second table
-- of the same fact would be a second place for it to be wrong, and the events are already kept verbatim.
--
-- What is stored is the exception. An administrator who knows the address is good again — the mailbox was
-- full, the complaint was a mis-click — lifts it here, with a reason, and the seal consults the lift: an
-- event **after** the lift suppresses again, because the address failed again after somebody vouched for it.
CREATE TABLE suppression_lifts (
  id         TEXT PRIMARY KEY,   -- spl_<ulid>
  org_id     TEXT NOT NULL,
  address    TEXT NOT NULL,      -- lower-cased, as `send_recipient_events.recipient` is compared
  reason     TEXT NOT NULL,      -- mandatory and non-empty; the next reader of the trail needs it
  lifted_by  TEXT NOT NULL,
  lifted_at  TEXT NOT NULL
);
CREATE INDEX spl_by_address ON suppression_lifts (org_id, address, lifted_at);
