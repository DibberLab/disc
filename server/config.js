'use strict';

/* Putter/driver max and set count are both per-user settings now, not
   constants — `users.putter_max`/`driver_max`/`putter_sets`/`driver_sets`
   are someone's current defaults, and `sessions.putter_max`/`driver_max`/
   `putter_sets`/`driver_sets` are a SNAPSHOT of those defaults taken when
   that particular session was first created (see server/routes/sessions.js
   — never touched again on a later edit of the same session, so a day's
   numbers stay correct even after the account's defaults change).

   The values below are only the fallback used where there's genuinely
   nothing else to ask (a not-yet-authenticated caller, or a test that
   doesn't care about ownership). session_sets' CHECK constraint is a
   generous sanity bound, not the real cap — the real cap is whichever of
   limitsForUser/limitsFromSnapshot applies, enforced in shape.js. */
const STATIONS = {
  p15: { max: 20, sets: 5, label: 'Putting 15 ft' },
  p25: { max: 20, sets: 5, label: 'Putting 25 ft' },
  bh:  { max: 14, sets: 5, label: 'Net backhand' },
  fh:  { max: 14, sets: 5, label: 'Net forehand' }
};

/* Which per-user/per-session setting governs each station. */
const STATION_CATEGORY = { p15: 'putter', p25: 'putter', bh: 'driver', fh: 'driver' };

const STATION_KEYS = Object.keys(STATIONS);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* Sanity bounds for the settings endpoint — generous enough that nobody
   legitimately hits them, tight enough to catch a fat-fingered value.
   Matches the loosened CHECK bounds in 002/004 (made 0-200, set_index 0-49). */
const MIN_MAX = 1, MAX_MAX = 200;
const MIN_SETS = 1, MAX_SETS = 50;

function limitsFor(putterMax, driverMax, putterSets, driverSets) {
  const out = {};
  for (const key of STATION_KEYS) {
    const isPutter = STATION_CATEGORY[key] === 'putter';
    out[key] = {
      max: (isPutter ? putterMax : driverMax) ?? STATIONS[key].max,
      sets: (isPutter ? putterSets : driverSets) ?? STATIONS[key].sets
    };
  }
  return out;
}

/* user is {putterMax, driverMax, putterSets, driverSets} (or null/undefined
   fields) — a live account's CURRENT settings. Used when there's no
   existing session yet to snapshot from (a brand new date). */
function limitsForUser(user) {
  return limitsFor(user && user.putterMax, user && user.driverMax, user && user.putterSets, user && user.driverSets);
}

/* row is an existing session's wire shape (has putterMax/driverMax/
   putterSets/driverSets already threaded through by shape.rowsToSessions).
   Used to validate/re-render an EXISTING session against the numbers that
   were true when it was first logged, not the account's current settings. */
function limitsFromSnapshot(row) {
  return limitsFor(row.putterMax, row.driverMax, row.putterSets, row.driverSets);
}

/* The flat {putterMax, driverMax, putterSets, driverSets} to stamp onto a
   brand-new session row at creation — see db.upsertSession's `snapshot`
   option. */
function snapshotForUser(user) {
  return {
    putterMax: (user && user.putterMax) ?? STATIONS.p15.max,
    driverMax: (user && user.driverMax) ?? STATIONS.bh.max,
    putterSets: (user && user.putterSets) ?? STATIONS.p15.sets,
    driverSets: (user && user.driverSets) ?? STATIONS.bh.sets
  };
}

/* Tombstones older than this are pruned on boot. A device that has been
   offline longer than this will resurrect a deleted session; at that point
   deleting it again is the fix. */
const TOMBSTONE_TTL_DAYS = 180;

module.exports = {
  STATIONS, STATION_KEYS, STATION_CATEGORY, DATE_RE, TOMBSTONE_TTL_DAYS,
  MIN_MAX, MAX_MAX, MIN_SETS, MAX_SETS,
  limitsForUser, limitsFromSnapshot, snapshotForUser
};
