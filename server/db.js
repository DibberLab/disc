'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { TOMBSTONE_TTL_DAYS, snapshotForUser } = require('./config');
const { rowsToSessions, sessionToSetRows } = require('./shape');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

let db = null;

function nowIso() { return new Date().toISOString(); }

/* Server-assigned timestamps must be strictly increasing, or two writes that
   land in the same millisecond are indistinguishable and `updated_at > since`
   silently drops one of them on the next sync. Bump by 1ms on a collision. */
let lastStamp = null;

function serverStamp() {
  let iso = nowIso();
  if (lastStamp && iso <= lastStamp) iso = new Date(Date.parse(lastStamp) + 1).toISOString();
  lastStamp = iso;
  return iso;
}

/* ------------------------------------------------------------------ open */
function open(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma('journal_mode = WAL');   // survives a container kill mid-write
  db.pragma('foreign_keys = ON');    // OFF by default in SQLite; the cascade
                                     // on session_sets depends on this
  db.pragma('busy_timeout = 5000');
  migrate();
  pruneTombstones();
  lastStamp = db.prepare('SELECT MAX(updated_at) AS t FROM sessions').get().t || null;
  return db;
}

function handle() {
  if (!db) throw new Error('db.open() has not been called');
  return db;
}

function close() { if (db) { db.close(); db = null; } }

/* ------------------------------------------------------------- migrate */
function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
             version    INTEGER PRIMARY KEY,
             name       TEXT NOT NULL,
             applied_at TEXT NOT NULL
           )`);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();                                   // 001_, 002_, … lexical == ordinal

  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
  );

  for (const file of files) {
    const version = parseInt(file.slice(0, 3), 10);
    if (Number.isNaN(version)) throw new Error(`migration ${file} must start with NNN_`);
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      record.run(version, file, nowIso());
    })();
    console.log(`[db] applied migration ${file}`);
  }
}

/* --------------------------------------------------------------- reads */

/* `since` is an ISO timestamp; omit it for everything. Sessions come back
   oldest-first, which is the order public/app.js expects. Unscoped by user
   by default — this is the full-visibility read path everyone gets once
   logged in, so every row carries who it belongs to. Pass `userId` to scope
   it to one user (used by /sync, which must only ever hand back the
   caller's own rows, never someone else's). */
function listSessions(since, userId) {
  const d = handle();
  const clauses = [];
  const params = [];
  if (since) { clauses.push('s.updated_at > ?'); params.push(since); }
  if (userId) { clauses.push('s.user_id = ?'); params.push(userId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  /* Deliberately NOT joining u.putter_max/u.driver_max/u.putter_sets/
     u.driver_sets here — s.* already carries the session's OWN locked-in
     snapshot of those (see 004_per_session_limits.sql), which is what the
     client needs for correct percentages/grid sizing on a row that might be
     from years ago, under a since-changed account default. Only username/
     display_name genuinely come from the live account. */
  const rows = d.prepare(
    `SELECT s.*, u.username, u.display_name FROM sessions s
       JOIN users u ON u.id = s.user_id
      ${where} ORDER BY s.date`
  ).all(...params);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const sets = d.prepare(
    `SELECT session_id, station, set_index, made FROM session_sets
      WHERE session_id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids);
  return rowsToSessions(rows, sets);
}

/* Ownership-scoped: used by the PUT/GET-by-date paths, which only ever
   operate on the caller's own day. */
function getSession(userId, date) {
  const d = handle();
  const row = d.prepare('SELECT * FROM sessions WHERE user_id = ? AND date = ?').get(userId, date);
  if (!row) return null;
  const sets = d.prepare(
    'SELECT session_id, station, set_index, made FROM session_sets WHERE session_id = ?'
  ).all(row.id);
  return rowsToSessions([row], sets)[0];
}

/* Scoped to the caller — a sync pull should only ever hand back the
   tombstones for that caller's own outbox, never another user's deletes. */
function listDeletions(userId, since) {
  const d = handle();
  const rows = since
    ? d.prepare('SELECT date, deleted_at FROM deletions WHERE user_id = ? AND deleted_at > ?').all(userId, since)
    : d.prepare('SELECT date, deleted_at FROM deletions WHERE user_id = ?').all(userId);
  return rows.map((r) => ({ date: r.date, deletedAt: r.deleted_at }));
}

function stats() {
  const d = handle();
  return {
    sessions: d.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,
    sets: d.prepare('SELECT COUNT(*) AS n FROM session_sets').get().n,
    deletions: d.prepare('SELECT COUNT(*) AS n FROM deletions').get().n,
    lastUpdatedAt:
      d.prepare('SELECT MAX(updated_at) AS t FROM sessions').get().t || null
  };
}

/* -------------------------------------------------------------- writes */

/* Upsert one session, owned by userId. `stampNow: true` (a direct PUT from
   the UI) makes the server the clock; `false` (a sync push) honours the
   client's updatedAt, already clamped to <= now by shape.parseSession.
   Writing a session always clears any tombstone for that user+date —
   re-logging a deleted day undeletes it.

   `snapshot` ({putterMax, driverMax, putterSets, driverSets}) is written
   ONLY on the INSERT branch — an existing session's own locked-in numbers
   from when it was first created are never touched by a later edit, even if
   the account's current settings have since changed (falls back to
   snapshotForUser(undefined)'s constants if the caller forgot to pass one,
   which should never happen in practice — every route resolves this before
   calling in). */
function upsertSession(userId, session, { stampNow = true, snapshot } = {}) {
  const d = handle();
  const run = d.transaction((s) => {
    const ts = stampNow || !s.updatedAt ? serverStamp() : s.updatedAt;
    const existing = d.prepare(
      'SELECT id, created_at FROM sessions WHERE user_id = ? AND date = ?'
    ).get(userId, s.date);

    let id;
    if (existing) {
      d.prepare('UPDATE sessions SET notes = ?, updated_at = ? WHERE id = ?')
        .run(s.notes, ts, existing.id);
      id = existing.id;
      d.prepare('DELETE FROM session_sets WHERE session_id = ?').run(id);
    } else {
      const snap = snapshot || snapshotForUser(undefined);
      id = d.prepare(
        `INSERT INTO sessions
           (user_id, date, notes, updated_at, created_at, putter_max, driver_max, putter_sets, driver_sets)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(userId, s.date, s.notes, ts, ts, snap.putterMax, snap.driverMax, snap.putterSets, snap.driverSets)
        .lastInsertRowid;
    }

    const ins = d.prepare(
      'INSERT INTO session_sets (session_id, station, set_index, made) VALUES (?, ?, ?, ?)'
    );
    for (const r of sessionToSetRows(s)) ins.run(id, r.station, r.set_index, r.made);

    d.prepare('DELETE FROM deletions WHERE user_id = ? AND date = ?').run(userId, s.date);
    return { created: !existing };
  });

  const { created } = run(session);
  return { session: getSession(userId, session.date), created };
}

/* Returns true if a row was actually removed. The tombstone is written
   either way, so deleting a date this server has never seen still
   propagates to a device that does have it. */
function deleteSession(userId, date, deletedAt) {
  const d = handle();
  const ts = deletedAt || serverStamp();
  return d.transaction(() => {
    const info = d.prepare('DELETE FROM sessions WHERE user_id = ? AND date = ?').run(userId, date);
    d.prepare(
      `INSERT INTO deletions (user_id, date, deleted_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id, date) DO UPDATE SET deleted_at = excluded.deleted_at
       WHERE excluded.deleted_at > deletions.deleted_at`
    ).run(userId, date, ts);
    return info.changes > 0;
  })();
}

function pruneTombstones() {
  const cutoff = new Date(Date.now() - TOMBSTONE_TTL_DAYS * 86400000).toISOString();
  const n = handle().prepare('DELETE FROM deletions WHERE deleted_at < ?').run(cutoff).changes;
  if (n) console.log(`[db] pruned ${n} tombstone(s) older than ${TOMBSTONE_TTL_DAYS} days`);
  return n;
}

/* ---------------------------------------------------------------- sync */

/* Last-write-wins, with tombstones beating older writes. See docs/API.md
   for the full statement of the rules — this is the implementation of them.
   Everything happens in one transaction so a partial push can't land.
   Scoped to userId throughout — a sync push can only ever affect the
   caller's own rows, never another user's.

   `snapshots` is {date: {putterMax, driverMax, putterSets, driverSets}},
   pre-resolved by the caller (routes/sessions.js) for whichever incoming
   dates don't already have a session — see resolveLimitsAndSnapshot there.
   A date with no entry (because a session already existed for it when the
   caller checked) just falls through to upsertSession's existing-row branch,
   which ignores `snapshot` entirely. */
function applySync(userId, { sessions = [], deletions = [], snapshots = {} }) {
  const d = handle();
  return d.transaction(() => {
    const result = { upserted: [], deleted: [], skipped: [] };

    for (const s of sessions) {
      const tomb = d.prepare('SELECT deleted_at FROM deletions WHERE user_id = ? AND date = ?').get(userId, s.date);
      if (tomb && tomb.deleted_at >= s.updatedAt) {
        result.skipped.push({ date: s.date, reason: 'deleted-on-server' });
        continue;
      }
      const cur = d.prepare('SELECT updated_at FROM sessions WHERE user_id = ? AND date = ?').get(userId, s.date);
      if (cur && cur.updated_at >= s.updatedAt) {
        result.skipped.push({ date: s.date, reason: 'server-newer' });
        continue;
      }
      upsertSession(userId, s, { stampNow: false, snapshot: snapshots[s.date] });
      result.upserted.push(s.date);
    }

    for (const del of deletions) {
      const cur = d.prepare('SELECT updated_at FROM sessions WHERE user_id = ? AND date = ?').get(userId, del.date);
      if (cur && cur.updated_at > del.deletedAt) {
        result.skipped.push({ date: del.date, reason: 'server-newer' });
        continue;
      }
      deleteSession(userId, del.date, del.deletedAt);
      result.deleted.push(del.date);
    }

    return result;
  })();
}

/* -------------------------------------------------------------- import */

/* A restore from a backup file, scoped to userId. Each session is a
   deliberate write, same as a PUT, so it always wins and gets a fresh
   server stamp — there is no client updatedAt to compare against a device
   that has been offline for a month. "replace" additionally tombstones
   every existing session of this user's not in the file (never another
   user's); "merge" only touches the dates the file mentions. */
function applyImport(userId, sessions, mode, snapshots = {}) {
  const d = handle();
  return d.transaction(() => {
    const result = { upserted: [], deleted: [] };
    const incoming = new Set(sessions.map((s) => s.date));

    if (mode === 'replace') {
      const existing = d.prepare('SELECT date FROM sessions WHERE user_id = ?').all(userId).map((r) => r.date);
      for (const date of existing) {
        if (incoming.has(date)) continue;
        deleteSession(userId, date, serverStamp());
        result.deleted.push(date);
      }
    }

    for (const s of sessions) {
      upsertSession(userId, s, { stampNow: true, snapshot: snapshots[s.date] });
      result.upserted.push(s.date);
    }

    return result;
  })();
}

module.exports = {
  open, close, handle, migrate, nowIso, serverStamp,
  listSessions, getSession, listDeletions, stats,
  upsertSession, deleteSession, pruneTombstones, applySync, applyImport
};
