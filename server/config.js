'use strict';

/* The station definitions exist in THREE places and must agree:
     1. here (server-side validation)
     2. GRIDS in public/app.js (the form + the charts)
     3. the CHECK constraint in server/migrations/001_init.sql
   If you change a max or a set count, change all three in the same commit. */
const STATIONS = {
  p15: { max: 20, sets: 5, label: 'Putting 15 ft' },
  p25: { max: 20, sets: 5, label: 'Putting 25 ft' },
  bh:  { max: 12, sets: 5, label: 'Net backhand' },
  fh:  { max: 12, sets: 5, label: 'Net forehand' }
};

const STATION_KEYS = Object.keys(STATIONS);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* Tombstones older than this are pruned on boot. A device that has been
   offline longer than this will resurrect a deleted session; at that point
   deleting it again is the fix. */
const TOMBSTONE_TTL_DAYS = 180;

module.exports = { STATIONS, STATION_KEYS, DATE_RE, TOMBSTONE_TTL_DAYS };
