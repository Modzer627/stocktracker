-- Parts Checkout — D1 schema. Idempotent: safe to re-run on every deploy.

-- Technicians the parts manager maintains (the pick list on the tech page).
CREATE TABLE IF NOT EXISTS techs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  truck TEXT,                       -- optional van / truck number
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- Part numbers. Learned automatically from what techs type; the manager can
-- rename, merge and retire them. `norm` is the matching key (upper-case,
-- single-spaced) so "siga-ct1" and "SIGA-CT1" are the same part.
CREATE TABLE IF NOT EXISTS parts (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL,
  norm TEXT NOT NULL UNIQUE,
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,  -- how many submission lines used it (sorts the pick list)
  last_used_at TEXT,
  created_at TEXT NOT NULL
);

-- Other spellings that map onto a part (created by merges).
CREATE TABLE IF NOT EXISTS part_aliases (
  alias_norm TEXT PRIMARY KEY,
  part_id TEXT NOT NULL
);

-- One form submission: a tech taking, returning or requesting parts.
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,               -- take | return | request
  tech_id TEXT NOT NULL,
  tech_name TEXT NOT NULL,          -- copied at submit time so renames don't rewrite history
  dest TEXT NOT NULL,               -- van | job | other
  job TEXT,                         -- job number when dest = job, free text when dest = other
  needed_by TEXT,                   -- requests: YYYY-MM-DD
  note TEXT,
  photo_key TEXT,
  status TEXT,                      -- requests: open | ordered | received | closed
  source TEXT NOT NULL DEFAULT 'web',
  edit_token TEXT,                  -- lets the submitting phone fix or delete it for 24 h
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_submissions_created ON submissions(created_at);
CREATE INDEX IF NOT EXISTS idx_submissions_type ON submissions(type, status);

-- The parts on a submission, one row per part.
CREATE TABLE IF NOT EXISTS lines (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  part_id TEXT,
  part_text TEXT NOT NULL,          -- exactly what the tech typed or picked
  qty REAL NOT NULL,
  pos INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lines_submission ON lines(submission_id);

-- Per-week bookkeeping for the manager (key = the Monday, YYYY-MM-DD).
CREATE TABLE IF NOT EXISTS weeks (
  week_key TEXT PRIMARY KEY,
  reviewed_at TEXT,
  note TEXT
);

-- Photos attached to returns / requests, stored as base64 JPEG (≈150 KB each).
CREATE TABLE IF NOT EXISTS photos (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
