-- Budget sync schema. Idempotent: apply with
--   npx wrangler@4 d1 execute budget-sync --remote --file=schema.sql

-- One row per synced record (txns / categories / recurring / shared), stored
-- as full JSON. updated_at mirrors data.updatedAt for the last-write-wins
-- check; seq is the monotonic pull cursor.
CREATE TABLE IF NOT EXISTS records (
  store TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (store, id)
);
CREATE INDEX IF NOT EXISTS idx_records_seq ON records(seq);

CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO counters (name, value) VALUES ('seq', 0);

-- Receipt photos as base64 text (~135 KB each; D1 row cap 2 MB, DB cap 500 MB)
CREATE TABLE IF NOT EXISTS photos (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Web-push subscriptions, one per device (endpoint is the natural key)
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  sub TEXT NOT NULL,
  created_at TEXT NOT NULL
);
