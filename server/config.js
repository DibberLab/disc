'use strict';

/* `sets` (how many sets of each station get thrown) still has to agree in
   TWO places: here and GRIDS[key].count in public/app.js. `max` (how many
   discs are in a set) used to be a third fixed copy, plus the CHECK
   constraint in 001_init.sql — it's no longer a constant at all, now that
   putter/driver counts are per-user data (users.putter_max/driver_max). The
   values below are only the fallback used where there's no logged-in user
   to ask (e.g. a not-yet-authenticated caller, or a test that doesn't care
   about ownership). session_sets' CHECK constraint was loosened to a
   generous sanity bound in 002_users_and_ownership.sql; the real per-user
   cap is enforced here, in maxesForUser(). */
const STATIONS = {
  p15: { max: 20, sets: 5, label: 'Putting 15 ft' },
  p25: { max: 20, sets: 5, label: 'Putting 25 ft' },
  bh:  { max: 14, sets: 5, label: 'Net backhand' },
  fh:  { max: 14, sets: 5, label: 'Net forehand' }
};

/* Which per-user setting governs each station's max. */
const STATION_CATEGORY = { p15: 'putter', p25: 'putter', bh: 'driver', fh: 'driver' };

const STATION_KEYS = Object.keys(STATIONS);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* user is {putterMax, driverMax} (or undefined/null) — falls back to the
   STATIONS defaults above when there's no user to ask. */
function maxesForUser(user) {
  const out = {};
  for (const key of STATION_KEYS) {
    const fromUser = STATION_CATEGORY[key] === 'putter' ? user && user.putterMax : user && user.driverMax;
    out[key] = fromUser != null ? fromUser : STATIONS[key].max;
  }
  return out;
}

/* Tombstones older than this are pruned on boot. A device that has been
   offline longer than this will resurrect a deleted session; at that point
   deleting it again is the fix. */
const TOMBSTONE_TTL_DAYS = 180;

module.exports = { STATIONS, STATION_KEYS, STATION_CATEGORY, DATE_RE, TOMBSTONE_TTL_DAYS, maxesForUser };
