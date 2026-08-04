-- Threading anchors and the parse state.
-- Additive (#10 expand/contract): no DROP, so no bookmark gate.
--
-- Two anchors, not the whole chain, and the bound is load-bearing rather than tidy. A `References`
-- header grows with its thread, so storing it whole would make this row grow without bound — and
-- `message-metadata-bytes.md` measured 1,253 bytes per message, from which §11B's shard thresholds
-- are derived. An unbounded column invalidates that arithmetic silently.
--
-- Threading needs exactly two single ids: the root of the conversation and the immediate parent. The
-- full chain stays in the immutable MIME, where a reply assembles its own `References` from it at
-- composition time — a read the composer performs anyway to quote the body. `To` and `Cc` are absent
-- for the same reason: reply-all needs them, and reply-all is composing.
ALTER TABLE messages ADD COLUMN in_reply_to TEXT;          -- parent's Message-ID, NULL if none
ALTER TABLE messages ADD COLUMN thread_root_rfc_id TEXT;   -- first References id, else own Message-ID

-- The visible-but-unparsed state. §24 forbids losing accepted mail, so a message whose headers
-- cannot be read must still be listed and downloadable — never silently absent, and never presented
-- as if it had been understood.
ALTER TABLE messages ADD COLUMN parse_error TEXT;          -- NULL when parsing succeeded

-- Threading read: every message sharing a root, in order.
CREATE INDEX msg_by_root ON messages (org_id, thread_root_rfc_id, sent_at);
-- Parent lookup, for attaching a reply to what it answers.
CREATE INDEX msg_by_rfc_id ON messages (org_id, rfc_message_id);
