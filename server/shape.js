'use strict';

const { STATIONS, STATION_KEYS, DATE_RE, maxesForUser } = require('./config');

/* Wire shape (identical to what public/app.js has always held in memory,
   plus updatedAt):

     { date: '2026-08-26',
       p15: [18, 17, null, 16, 15],
       p25: [11,  9, null, 10,  8],
       bh:  [ 7,  8,    6, null, 7],
       fh:  [ 5,  6,    4, null, 5],
       notes: 'headwind out of the north',
       updatedAt: '2026-08-26T14:03:11.212Z' }                              */

class ValidationError extends Error {
  constructor(message) { super(message); this.name = 'ValidationError'; }
}

function isIsoDate(v) {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === v;   // rejects 2026-02-30
}

/* Coerce one station array. Throws on anything that is not null or an
   in-range integer — the client clamps, the server refuses. Silently
   clamping here would hide a real client bug. `max` is the caller's
   resolved per-user putter/driver count (see config.maxesForUser), not a
   fixed constant — `sets` (how many sets get thrown) is still fixed. */
function cleanStation(key, value, max) {
  const cfg = STATIONS[key];
  if (value === undefined || value === null) return new Array(cfg.sets).fill(null);
  if (!Array.isArray(value)) throw new ValidationError(`${key} must be an array`);
  if (value.length > cfg.sets) throw new ValidationError(`${key} has more than ${cfg.sets} sets`);

  const out = new Array(cfg.sets).fill(null);
  for (let i = 0; i < cfg.sets; i++) {
    const v = value[i];
    if (v === null || v === undefined || v === '') continue;
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      throw new ValidationError(`${key}[${i}] must be an integer or null`);
    }
    if (v < 0 || v > max) {
      throw new ValidationError(`${key}[${i}] must be between 0 and ${max}`);
    }
    out[i] = v;
  }
  return out;
}

/* Validate an inbound session. `date` from the URL path wins over the body.
   `user` ({putterMax, driverMax}) resolves the per-user maxes; omit it (e.g.
   in tests that don't care about ownership) to fall back to config.js's
   defaults. `userId`/`username`, if present in the body, are ignored —
   ownership always comes from the caller's session, never the payload. */
function parseSession(body, dateFromPath, user) {
  if (!body || typeof body !== 'object') throw new ValidationError('body must be an object');
  const date = dateFromPath || body.date;
  if (!isIsoDate(date)) throw new ValidationError('date must be YYYY-MM-DD');

  const maxes = maxesForUser(user);
  const out = { date, notes: '', updatedAt: null };
  for (const key of STATION_KEYS) out[key] = cleanStation(key, body[key], maxes[key]);

  if (body.notes !== undefined && body.notes !== null) {
    if (typeof body.notes !== 'string') throw new ValidationError('notes must be a string');
    if (body.notes.length > 4000) throw new ValidationError('notes is longer than 4000 characters');
    out.notes = body.notes;
  }

  if (body.updatedAt !== undefined && body.updatedAt !== null) {
    const t = new Date(body.updatedAt);
    if (isNaN(t)) throw new ValidationError('updatedAt must be an ISO-8601 timestamp');
    /* Clamp a client clock that is running fast, or one bad phone clock
       pins every future sync as "server is stale". */
    out.updatedAt = new Date(Math.min(t.getTime(), Date.now())).toISOString();
  }

  if (!hasAnyThrow(out)) throw new ValidationError('session has no sets recorded');
  return out;
}

function hasAnyThrow(session) {
  return STATION_KEYS.some((k) => session[k].some((v) => v !== null));
}

/* Rows out of the DB -> wire shape. `setRows` may cover many sessions.
   `userId`/`username`/`putterMax`/`driverMax` are only present when the row
   came from a query that joined `users` (the full-visibility read paths) —
   a plain per-owner query doesn't need to tell the caller who they already
   know they are. putterMax/driverMax let the client compute percentages
   correctly for a row that isn't necessarily the viewer's own. */
function rowsToSessions(sessionRows, setRows) {
  const byId = new Map();
  for (const r of sessionRows) {
    const s = { date: r.date, notes: r.notes, updatedAt: r.updated_at };
    if (r.user_id !== undefined) s.userId = r.user_id;
    if (r.username !== undefined) s.username = r.username;
    if (r.putter_max !== undefined) s.putterMax = r.putter_max;
    if (r.driver_max !== undefined) s.driverMax = r.driver_max;
    for (const k of STATION_KEYS) s[k] = new Array(STATIONS[k].sets).fill(null);
    byId.set(r.id, s);
  }
  for (const sr of setRows) {
    const s = byId.get(sr.session_id);
    if (s) s[sr.station][sr.set_index] = sr.made;
  }
  return [...byId.values()];
}

/* Wire shape -> flat rows for session_sets. Nulls are omitted, not zeroed. */
function sessionToSetRows(session) {
  const rows = [];
  for (const station of STATION_KEYS) {
    session[station].forEach((made, set_index) => {
      if (made !== null && made !== undefined) rows.push({ station, set_index, made });
    });
  }
  return rows;
}

module.exports = {
  ValidationError, isIsoDate, parseSession, hasAnyThrow,
  rowsToSessions, sessionToSetRows
};
