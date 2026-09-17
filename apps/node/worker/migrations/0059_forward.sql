-- Forwarding: a send that carries another message whole.
-- phase: expand
--
-- The forwarded original is not quoted, rewritten or re-encoded: `renderRfc822` puts its stored evidence
-- bytes into the outgoing message as a `message/rfc822` part, verbatim, beside the text the author typed.
-- What a recipient receives is the message as this Node received it, which is the only forward that can be
-- proved to be one. The column names which message; the authority to name it is the same as a reply's —
-- read on the mailbox it was delivered into — and the seal refuses to forward a message carrying an
-- attachment this Node judges dangerous (0057), because a verdict the Node then ships past is not one.
ALTER TABLE send_manifests ADD COLUMN forward_of_message_id TEXT;
