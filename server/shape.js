'use strict';

const { STATIONS, STATION_KEYS, STATION_CATEGORY, DATE_RE, limitsForUser } = require('./config');

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
   clamping here would hide a real client bug. `limit` is {max, sets} —
   resolved by the caller from either the account's current settings (a
   brand-new session) or the session's own locked-in snapshot (editing an
   existing one) — see config.limitsForUser/limitsFromSnapshot. Neither max
   nor sets is a fixed constant any more. */
function cleanStation(key, value, limit) {
  if (value === undefined || value === null) return new Array(limit.sets).fill(null);
  if (!Array.isArray(value)) throw new ValidationError(`${key} must be an array`);
  if (value.length > limit.sets) throw new ValidationError(`${key} has more than ${limit.sets} sets`);

  const out = new Array(limit.sets).fill(null);
  for (let i = 0; i < limit.sets; i++) {
    const v = value[i];
    if (v === null || v === undefined || v === '') continue;
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      throw new ValidationError(`${key}[${i}] must be an integer or null`);
    }
    if (v < 0 || v > limit.max) {
      throw new ValidationError(`${key}[${i}] must be between 0 and ${limit.max}`);
    }
    out[i] = v;
  }
  return out;
}

/* Validate an inbound session. `date` from the URL path wins over the body.
   `limits` is {p15, p25, bh, fh}, each {max, sets} — omit it (e.g. in tests
   that don't care about ownership) to fall back to config.js's defaults via
   limitsForUser(undefined). `userId`/`username`/`putterMax`/etc, if present
   in the body, are ignored — ownership and limits always come from the
   caller's session server-side, never the payload. */
function parseSession(body, dateFromPath, limits) {
  if (!body || typeof body !== 'object') throw new ValidationError('body must be an object');
  const date = dateFromPath || body.date;
  if (!isIsoDate(date)) throw new ValidationError('date must be YYYY-MM-DD');

  const resolved = limits || limitsForUser(undefined);
  const out = { date, notes: '', updatedAt: null };
  for (const key of STATION_KEYS) out[key] = cleanStation(key, body[key], resolved[key]);

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
   `userId`/`username`/`displayName` are only present when the row came from
   a query that joined `users` (the full-visibility read paths) — a plain
   per-owner query doesn't need to tell the caller who they already know
   they are. displayName falls back to username when no display name is set
   (see 003_display_name.sql). putterMax/driverMax/putterSets/driverSets are
   the session's OWN columns (see 004_per_session_limits.sql) — always
   present on any row that came from `sessions`, since they're real columns
   there now, not something else's data joined in. They're what the client
   needs for correct percentages and grid sizing on a row that might be from
   long before the account's current settings, its own or someone else's. */
function rowsToSessions(sessionRows, setRows) {
  const byId = new Map();
  for (const r of sessionRows) {
    const s = { date: r.date, notes: r.notes, updatedAt: r.updated_at };
    if (r.user_id !== undefined) s.userId = r.user_id;
    if (r.username !== undefined) {
      s.username = r.username;
      s.displayName = r.display_name || r.username;
    }
    if (r.putter_max !== undefined) s.putterMax = r.putter_max;
    if (r.driver_max !== undefined) s.driverMax = r.driver_max;
    if (r.putter_sets !== undefined) s.putterSets = r.putter_sets;
    if (r.driver_sets !== undefined) s.driverSets = r.driver_sets;
    for (const k of STATION_KEYS) {
      const sets = STATION_CATEGORY[k] === 'putter'
        ? (r.putter_sets ?? STATIONS[k].sets)
        : (r.driver_sets ?? STATIONS[k].sets);
      s[k] = new Array(sets).fill(null);
    }
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
