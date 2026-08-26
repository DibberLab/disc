-- 004_per_session_limits.sql — adjustable set counts, and each session
-- locks in the putter/driver max AND set count that were true when it was
-- first logged, instead of always reflecting the account's current
-- settings. A day you only had 16 drivers stays correct forever, even after
-- the account's default later changes to 20 — see server/routes/sessions.js
-- for where the snapshot actually gets taken (on create only, never on a
-- later edit of the same session).

ALTER TABLE users ADD COLUMN putter_sets INTEGER NOT NULL DEFAULT 5;
ALTER TABLE users ADD COLUMN driver_sets INTEGER NOT NULL DEFAULT 5;

ALTER TABLE sessions ADD COLUMN putter_max INTEGER NOT NULL DEFAULT 20;
ALTER TABLE sessions ADD COLUMN driver_max INTEGER NOT NULL DEFAULT 14;
ALTER TABLE sessions ADD COLUMN putter_sets INTEGER NOT NULL DEFAULT 5;
ALTER TABLE sessions ADD COLUMN driver_sets INTEGER NOT NULL DEFAULT 5;

-- set_index's CHECK was hardcoded to a fixed 5-set day (0-4). Loosen it the
-- same way 002 loosened `made` — a generous sanity backstop, not the real
-- cap (the real cap is each session's own putter_sets/driver_sets, enforced
-- in shape.js, since SQL can't reference another row's data). Nothing else
-- has a foreign key into session_sets, so unlike 002's rebuild of
-- `sessions`, there's no cascade-on-drop hazard here to route around.
CREATE TABLE session_sets_new (
  session_id INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  station    TEXT    NOT NULL CHECK (station IN ('p15', 'p25', 'bh', 'fh')),
  set_index  INTEGER NOT NULL CHECK (set_index BETWEEN 0 AND 49),
  made       INTEGER NOT NULL CHECK (made BETWEEN 0 AND 200),
  PRIMARY KEY (session_id, station, set_index)
) WITHOUT ROWID;

INSERT INTO session_sets_new SELECT * FROM session_sets;
DROP TABLE session_sets;
ALTER TABLE session_sets_new RENAME TO session_sets;
