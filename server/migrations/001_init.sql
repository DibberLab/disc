-- 001_init.sql — disc golf training log
--
-- One row per calendar date in `sessions`; the five sets at each of the four
-- stations live in `session_sets`. A set that was never thrown has NO ROW here
-- (that is how the client's `null` round-trips) — a set that was thrown and
-- missed everything is a row with made = 0. Do not conflate the two.

CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL UNIQUE
             CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  notes      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,   -- ISO-8601 UTC, e.g. 2026-08-26T14:03:11.212Z
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions (updated_at);

CREATE TABLE IF NOT EXISTS session_sets (
  session_id INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  station    TEXT    NOT NULL CHECK (station IN ('p15', 'p25', 'bh', 'fh')),
  set_index  INTEGER NOT NULL CHECK (set_index BETWEEN 0 AND 4),
  made       INTEGER NOT NULL CHECK (
               made >= 0 AND
               made <= CASE WHEN station IN ('p15', 'p25') THEN 20 ELSE 12 END
             ),
  PRIMARY KEY (session_id, station, set_index)
) WITHOUT ROWID;

-- Tombstones. A delete on one device has to beat a stale copy of the same
-- session sitting in another device's outbox, so deletes are recorded, not
-- just applied. Pruned by age in server/db.js.
CREATE TABLE IF NOT EXISTS deletions (
  date       TEXT PRIMARY KEY
             CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  deleted_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deletions_deleted_at ON deletions (deleted_at);
