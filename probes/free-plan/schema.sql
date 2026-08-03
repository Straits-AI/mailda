CREATE TABLE IF NOT EXISTS received (
  id         TEXT PRIMARY KEY,
  from_addr  TEXT NOT NULL,
  to_addr    TEXT NOT NULL,
  subject    TEXT NOT NULL,
  raw_bytes  INTEGER NOT NULL,
  at         TEXT NOT NULL
);
