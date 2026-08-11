CREATE TABLE IF NOT EXISTS snapshots (
  tech_id TEXT PRIMARY KEY,
  tech_name TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL
);
