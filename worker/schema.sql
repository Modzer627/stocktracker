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

-- v1.3: commands pushed down to tech phones (transfers), applied on next open
CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  tech_id TEXT NOT NULL,          -- target phone
  type TEXT NOT NULL,             -- transfer_out | transfer_in
  payload TEXT NOT NULL,          -- {qty, item:{...}, otherTech, groupId}
  status TEXT NOT NULL,           -- pending | applied
  created_at TEXT NOT NULL
);

-- v1.4: shared item photos, stored as base64 text (~135 KB per photo;
-- D1 row cap is 2 MB, DB cap 500 MB ≈ 3,700 photos of headroom)
CREATE TABLE IF NOT EXISTS photos (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- v1.5: the master parts catalog — the source of truth for what parts exist.
-- Phones hold working copies; deleting an item on a phone never touches this
-- table. Rows are soft-deleted (deleted = 1) so history is never lost.
CREATE TABLE IF NOT EXISTS catalog (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  barcode TEXT,
  category TEXT,
  unit TEXT NOT NULL DEFAULT 'pcs',
  min_qty REAL NOT NULL DEFAULT 0,
  cost REAL,
  notes TEXT,
  photo TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- v1.2: web-push subscriptions (endpoint URL is the natural unique key)
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  tech_id TEXT NOT NULL,
  role TEXT NOT NULL,             -- tech | manager
  sub TEXT NOT NULL,              -- full subscription JSON
  created_at TEXT NOT NULL
);
