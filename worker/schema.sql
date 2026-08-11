CREATE TABLE IF NOT EXISTS snapshots (
  tech_id TEXT PRIMARY KEY,
  tech_name TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL
);

-- v1.2: item-add requests (techs propose, managers decide)
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  tech_id TEXT NOT NULL,
  tech_name TEXT NOT NULL,
  status TEXT NOT NULL,           -- pending | approved | rejected | applied | closed
  target TEXT,                    -- tech | team (chosen by the manager at decision time)
  payload TEXT NOT NULL,          -- proposed item fields as JSON
  manager_note TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

-- v1.2: web-push subscriptions (endpoint URL is the natural unique key)
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  tech_id TEXT NOT NULL,
  role TEXT NOT NULL,             -- tech | manager
  sub TEXT NOT NULL,              -- full subscription JSON
  created_at TEXT NOT NULL
);
