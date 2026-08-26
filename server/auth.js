'use strict';

const crypto = require('crypto');
const db = require('./db');

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
    `SELECT w.token, u.id AS user_id, u.username, u.putter_max, u.driver_max
       FROM web_sessions w JOIN users u ON u.id = w.user_id
      WHERE w.token = ?`
  ).get(token);
  if (!row) return null;
  d.prepare('UPDATE web_sessions SET last_seen_at = ? WHERE token = ?').run(db.nowIso(), token);
  return {
    id: row.user_id,
    username: row.username,
    putterMax: row.putter_max,
    driverMax: row.driver_max
  };
}

function destroySession(token) {
  if (!token) return;
  db.handle().prepare('DELETE FROM web_sessions WHERE token = ?').run(token);
}

function findUserByUsername(username) {
  return db.handle().prepare(
    'SELECT id, username, password_hash, putter_max, driver_max FROM users WHERE username = ?'
  ).get(username);
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
  findUserByUsername,
  COOKIE_NAME, tokenFromRequest
};
