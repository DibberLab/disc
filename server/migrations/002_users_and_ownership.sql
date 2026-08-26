-- 002_users_and_ownership.sql — multi-user accounts, per-user putter/driver
-- counts, and session ownership.
--
-- Every session logged so far belongs to one person, so this migration seeds
-- a single account ('andy') and attaches all existing data to it in the same
-- transaction. Login stays impossible until scripts/create-user.js sets a
-- real password: the placeholder hash below is of a random value nobody
-- knows, which is what keeps login refused instead of silently open.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  putter_max    INTEGER NOT NULL DEFAULT 20,
  driver_max    INTEGER NOT NULL DEFAULT 14,
  created_at    TEXT NOT NULL
);

-- Login cookie sessions. Named web_sessions, not "sessions" — that noun
-- already means one day's training log everywhere else in this codebase.
CREATE TABLE IF NOT EXISTS web_sessions (
  token        TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_web_sessions_user_id ON web_sessions (user_id);

INSERT INTO users (username, password_hash, putter_max, driver_max, created_at)
VALUES ('andy', 'unset:' || lower(hex(randomblob(32))), 20, 14, datetime('now'));

-- sessions: rebuild to add user_id and move uniqueness from (date) to
-- (user_id, date). SQLite can't ALTER an inline UNIQUE away, so this is a
-- create-copy-drop-rename. Ids are preserved, so session_sets' session_id
-- foreign key stays valid with no changes needed to that table.
CREATE TABLE sessions_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users (id),
  date       TEXT NOT NULL
             CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  notes      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,   -- ISO-8601 UTC, e.g. 2026-08-26T14:03:11.212Z
  created_at TEXT NOT NULL,
  UNIQUE (user_id, date)
);

INSERT INTO sessions_new (id, user_id, date, notes, updated_at, created_at)
SELECT id, (SELECT id FROM users WHERE username = 'andy'), date, notes, updated_at, created_at
FROM sessions;

-- session_sets: loosen the hardcoded 20/12 CHECK to a generous sanity bound
-- at the same time. The real per-user cap now lives in server/shape.js — a
-- CHECK constraint can't reference the users table, so SQL can only ever be
-- a backstop, not the source of truth, once the cap became personal data.
--
-- This references sessions_new, not sessions, on purpose: dropping a table
-- that a live "ON DELETE CASCADE" child points at performs an implicit
-- cascading DELETE on that child first (SQLite fires FK actions on the
-- DROP), which would silently wipe every set the moment `DROP TABLE
-- sessions` below runs. Pointing at sessions_new sidesteps that — nothing
-- references the old `sessions` table anymore once session_sets is rebuilt,
-- so dropping it cascades into nothing. The rename two statements down then
-- rewrites this table's REFERENCES clause from sessions_new to sessions
-- automatically (SQLite does this on ALTER TABLE RENAME).
CREATE TABLE session_sets_new (
  session_id INTEGER NOT NULL REFERENCES sessions_new (id) ON DELETE CASCADE,
  station    TEXT    NOT NULL CHECK (station IN ('p15', 'p25', 'bh', 'fh')),
  set_index  INTEGER NOT NULL CHECK (set_index BETWEEN 0 AND 4),
  made       INTEGER NOT NULL CHECK (made BETWEEN 0 AND 200),
  PRIMARY KEY (session_id, station, set_index)
) WITHOUT ROWID;

INSERT INTO session_sets_new SELECT * FROM session_sets;
DROP TABLE session_sets;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
ALTER TABLE session_sets_new RENAME TO session_sets;

CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions (updated_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user_date ON sessions (user_id, date);

-- deletions: same rebuild, keyed by (user_id, date) instead of (date) alone
-- — a delete is now scoped to the account that made it.
CREATE TABLE deletions_new (
  user_id    INTEGER NOT NULL REFERENCES users (id),
  date       TEXT NOT NULL
             CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (user_id, date)
);

INSERT INTO deletions_new (user_id, date, deleted_at)
SELECT (SELECT id FROM users WHERE username = 'andy'), date, deleted_at
FROM deletions;

DROP TABLE deletions;
ALTER TABLE deletions_new RENAME TO deletions;

CREATE INDEX IF NOT EXISTS idx_deletions_deleted_at ON deletions (deleted_at);
