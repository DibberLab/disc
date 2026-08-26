'use strict';

const crypto = require('crypto');
const db = require('./db');
const { ValidationError } = require('./shape');
const { MIN_MAX, MAX_MAX, MIN_SETS, MAX_SETS } = require('./config');

const USERNAME_RE = /^[a-zA-Z0-9_-]{2,32}$/;
const MIN_PASSWORD_LEN = 8;

/* scrypt params: Node's own recommended minimums (N=16384, r=8, p=1). Stored
   alongside the hash so a future param bump doesn't break existing accounts
   — verifyPassword reads whatever params the hash itself was made with. */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, encoded) {
  const parts = String(encoded).split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltHex, hashHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length, {
    N: Number(n), r: Number(r), p: Number(p)
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/* ------------------------------------------------------- login sessions
   Server-side session table, not a signed/stateless cookie: the token is
   just a high-entropy lookup key, so revoking a session (logout) is a plain
   DELETE instead of needing a blocklist. Kept in SQLite rather than memory
   so a deploy (docker compose up --build) doesn't silently log everyone
   out — see docs on why express-session's default MemoryStore was rejected. */
function createSession(userId) {
  const d = db.handle();
  const token = crypto.randomBytes(32).toString('base64url');
  const now = db.nowIso();
  d.prepare(
    'INSERT INTO web_sessions (token, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)'
  ).run(token, userId, now, now);
  return token;
}

function getSession(token) {
  if (!token) return null;
  const d = db.handle();
  const row = d.prepare(
    `SELECT w.token, u.id AS user_id, u.username, u.display_name,
            u.putter_max, u.driver_max, u.putter_sets, u.driver_sets
       FROM web_sessions w JOIN users u ON u.id = w.user_id
      WHERE w.token = ?`
  ).get(token);
  if (!row) return null;
  d.prepare('UPDATE web_sessions SET last_seen_at = ? WHERE token = ?').run(db.nowIso(), token);
  return {
    id: row.user_id,
    username: row.username,
    displayName: row.display_name || row.username,
    putterMax: row.putter_max,
    driverMax: row.driver_max,
    putterSets: row.putter_sets,
    driverSets: row.driver_sets
  };
}

function destroySession(token) {
  if (!token) return;
  db.handle().prepare('DELETE FROM web_sessions WHERE token = ?').run(token);
}

function findUserByUsername(username) {
  return db.handle().prepare(
    `SELECT id, username, display_name, password_hash,
            putter_max, driver_max, putter_sets, driver_sets
       FROM users WHERE username = ?`
  ).get(username);
}

/* Creates a new account with default putter/driver maxes (20/14 — see the
   `users` table default). `displayName` is optional and purely cosmetic —
   see 003_display_name.sql. Used by both scripts/create-user.js and
   POST /api/register; the route is what gates this to logged-in users only
   — there's deliberately no public signup, this function itself doesn't
   know or care who's calling it. Throws ValidationError (never a raw SQLite
   error) so callers can turn it into a clean 400. */
function createUser(username, password, displayName) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    throw new ValidationError('username must be 2-32 characters: letters, numbers, - or _');
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
    throw new ValidationError(`password must be at least ${MIN_PASSWORD_LEN} characters`);
  }
  if (findUserByUsername(username)) {
    throw new ValidationError('that username is already taken');
  }
  const hash = hashPassword(password);
  const cleanDisplayName = typeof displayName === 'string' && displayName.trim() ? displayName.trim() : null;
  const info = db.handle().prepare(
    'INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?)'
  ).run(username, cleanDisplayName, hash, db.nowIso());
  return info.lastInsertRowid;
}

/* Updates the caller's OWN putter/driver max and set count — the settings
   screen. Only touches fields actually present in `patch`; omitted fields
   are left as they are. This changes the account's going-forward DEFAULT
   only — it never rewrites any existing session's own locked-in snapshot
   (see 004_per_session_limits.sql and routes/sessions.js), so past days
   stay correct. Returns the updated row. */
const SETTINGS_FIELDS = {
  putterMax: { column: 'putter_max', min: MIN_MAX, max: MAX_MAX, label: 'putter max' },
  driverMax: { column: 'driver_max', min: MIN_MAX, max: MAX_MAX, label: 'driver max' },
  putterSets: { column: 'putter_sets', min: MIN_SETS, max: MAX_SETS, label: 'putter sets' },
  driverSets: { column: 'driver_sets', min: MIN_SETS, max: MAX_SETS, label: 'driver sets' }
};

function updateUserSettings(userId, patch) {
  const sets = [];
  const params = [];
  for (const key of Object.keys(SETTINGS_FIELDS)) {
    if (!(key in patch)) continue;
    const { column, min, max, label } = SETTINGS_FIELDS[key];
    const v = patch[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      throw new ValidationError(`${label} must be an integer between ${min} and ${max}`);
    }
    sets.push(`${column} = ?`);
    params.push(v);
  }
  if (!sets.length) throw new ValidationError('nothing to update');
  params.push(userId);
  db.handle().prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return db.handle().prepare(
    'SELECT username, display_name, putter_max, driver_max, putter_sets, driver_sets FROM users WHERE id = ?'
  ).get(userId);
}

/* ---------------------------------------------------------------- cookie
   No cookie-parser dependency — the app only ever sets/reads this one
   cookie, so a tiny hand-rolled parse is less than pulling in a package. */
const COOKIE_NAME = 'dg_session';

function tokenFromRequest(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

module.exports = {
  hashPassword, verifyPassword,
  createSession, getSession, destroySession,
  findUserByUsername, createUser, updateUserSettings,
  COOKIE_NAME, tokenFromRequest
};
