'use strict';

const express = require('express');
const db = require('../db');
const { parseSession, isIsoDate, ValidationError } = require('../shape');
const { limitsForUser, limitsFromSnapshot, snapshotForUser } = require('../config');

const router = express.Router();

function bad(res, message) { return res.status(400).json({ error: message }); }

/* The one thing every write path needs to decide first: is this date a
   brand-new session (validate against and snapshot the account's CURRENT
   settings) or an existing one (validate against and preserve ITS OWN
   locked-in numbers, untouched by whatever the account's settings are
   today)? See 004_per_session_limits.sql and config.js for why. */
function resolveLimitsAndSnapshot(userId, date, user) {
  const existing = db.getSession(userId, date);
  return existing
    ? { limits: limitsFromSnapshot(existing), snapshot: null }
    : { limits: limitsForUser(user), snapshot: snapshotForUser(user) };
}

/* GET /api/health — also what the Docker healthcheck hits. Deliberately not
   behind requireAuth (see index.js) — the container healthcheck has no
   session cookie. */
router.get('/health', (req, res) => {
  res.json({ ok: true, serverTime: db.nowIso(), ...db.stats() });
});

/* GET /api/sessions[?since=ISO] — oldest first, everyone's, each tagged with
   userId/username. Full visibility: any logged-in user sees every user's
   sessions, not just their own. */
router.get('/sessions', (req, res) => {
  const since = req.query.since;
  if (since !== undefined && isNaN(new Date(since))) return bad(res, 'since must be ISO-8601');
  const serverTime = db.nowIso();
  res.json({ serverTime, sessions: db.listSessions(since) });
});

/* Scoped to the caller's own date — someone else's session on this date, if
   any, isn't reachable through this path. */
router.get('/sessions/:date', (req, res) => {
  if (!isIsoDate(req.params.date)) return bad(res, 'date must be YYYY-MM-DD');
  const s = db.getSession(req.user.id, req.params.date);
  if (!s) return res.status(404).json({ error: 'no session on that date' });
  res.json(s);
});

/* PUT /api/sessions/:date — upsert, idempotent, always into the caller's own
   date-slot (req.user.id, never a URL/body param — no cross-user editing).
   This is the plain "Save session" path: a deliberate write from the UI
   always wins, and the server stamps updatedAt. Conflict resolution lives
   in POST /sync, not here. */
router.put('/sessions/:date', (req, res, next) => {
  try {
    const { limits, snapshot } = resolveLimitsAndSnapshot(req.user.id, req.params.date, req.user);
    const session = parseSession(req.body, req.params.date, limits);
    const { session: stored, created } = db.upsertSession(req.user.id, session, { stampNow: true, snapshot });
    res.status(created ? 201 : 200).json(stored);
  } catch (err) { next(err); }
});

router.delete('/sessions/:date', (req, res) => {
  if (!isIsoDate(req.params.date)) return bad(res, 'date must be YYYY-MM-DD');
  const existed = db.deleteSession(req.user.id, req.params.date, db.nowIso());
  res.status(existed ? 204 : 404).end();
});

/* POST /api/sync — the offline reconciliation endpoint.
   Body: { since?, sessions: [], deletions: [{date, deletedAt}] }
   See docs/API.md for the merge rules. */
router.post('/sync', (req, res, next) => {
  try {
    /* Captured BEFORE anything is applied. If it were taken after, a write
       that landed between the read and the stamp would fall in the gap and
       never come back on a later `?since=` pull. */
    const serverTime = db.nowIso();
    const body = req.body || {};
    const since = body.since;
    if (since !== undefined && since !== null && isNaN(new Date(since))) {
      return bad(res, 'since must be ISO-8601');
    }

    const incoming = [];
    const snapshots = {};
    for (const raw of Array.isArray(body.sessions) ? body.sessions : []) {
      /* A garbage date here just means no existing row will ever match —
         parseSession is what actually rejects it, with a clear error. */
      const lookupDate = raw && typeof raw.date === 'string' ? raw.date : null;
      const { limits, snapshot } = resolveLimitsAndSnapshot(req.user.id, lookupDate, req.user);
      const s = parseSession(raw, null, limits);
      if (snapshot) snapshots[s.date] = snapshot;
      /* An outbox entry without a timestamp can't be ordered against the
         server copy, so treat it as "now" — the client should always send one. */
      if (!s.updatedAt) s.updatedAt = db.nowIso();
      incoming.push(s);
    }

    const deletions = [];
    for (const raw of Array.isArray(body.deletions) ? body.deletions : []) {
      if (!raw || !isIsoDate(raw.date)) throw new ValidationError('deletion.date must be YYYY-MM-DD');
      const t = raw.deletedAt ? new Date(raw.deletedAt) : new Date();
      if (isNaN(t)) throw new ValidationError('deletion.deletedAt must be ISO-8601');
      deletions.push({
        date: raw.date,
        deletedAt: new Date(Math.min(t.getTime(), Date.now())).toISOString()
      });
    }

    /* Scoped to the caller: sync only ever pushes/pulls the logged-in
       user's own outbox, never another user's data. Full visibility into
       everyone else's sessions comes from GET /sessions, not sync. */
    const applied = db.applySync(req.user.id, { sessions: incoming, deletions, snapshots });

    /* Reply with everything the caller has not seen. Read AFTER applying so
       the client's own writes come back stamped and it can drop its outbox. */
    res.json({
      serverTime,
      applied,
      sessions: db.listSessions(since || undefined, req.user.id),
      deletions: db.listDeletions(req.user.id, since || undefined)
    });
  } catch (err) { next(err); }
});

/* GET /api/export.json — same envelope the old "Back up as JSON" button
   produced, so an export from either side restores into the other. */
router.get('/export.json', (req, res) => {
  const sessions = db.listSessions();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="disc-golf-log-${new Date().toISOString().slice(0, 10)}.json"`
  );
  res.send(JSON.stringify({ app: 'dg-training-log', version: 2, sessions }, null, 2));
});

/* ------------------------------------------------------------ csv export
   Column list and math lifted from public/app.js (#exportCsv, putts(),
   netAll(), rate()) — keep the two in lockstep, the order has to match the
   spreadsheet's Session Log tab. */
function sum(arr) {
  return arr.reduce((a, v) => (v === null || v === undefined ? a : a + v), 0);
}
function thrown(arr, per) {
  return arr.reduce((a, v) => (v === null || v === undefined ? a : a + per), 0);
}
function rate(arr, per) {
  const t = thrown(arr, per);
  return t === 0 ? null : sum(arr) / t;
}
function csvCell(v) { return v === null || v === undefined ? '' : v; }
function pctCell(arr, per) {
  const r = rate(arr, per);
  return r === null ? '' : r.toFixed(4);
}
/* Sessions can have different set counts now (each locks in its own — see
   004_per_session_limits.sql), but a CSV needs one fixed column count for
   the whole file. Widest wins; shorter rows just get blank cells. */
function padCells(arr, n) {
  const out = arr.map(csvCell);
  while (out.length < n) out.push('');
  return out;
}
function setHeaders(label, n) {
  return Array.from({ length: n }, (_, i) => `${label} ${i + 1}`);
}

router.get('/export.csv', (req, res) => {
  const sessions = db.listSessions();
  const pSets = Math.max(5, ...sessions.map((s) => s.p15.length));
  const dSets = Math.max(5, ...sessions.map((s) => s.bh.length));
  const head = ['Date', 'User',
    ...setHeaders('15ft Set', pSets), '15ft Made', '15ft %',
    ...setHeaders('25ft Set', pSets), '25ft Made', '25ft %',
    'Putts Made', 'Putt %',
    ...setHeaders('BH Rd', dSets), 'BH In',
    ...setHeaders('FH Rd', dSets), 'FH In',
    'Net In', 'Net %', 'Notes'];

  const lines = [head.join(',')];
  for (const s of sessions) {
    /* Each session's own locked-in maxes (see rowsToSessions in shape.js) —
       not a lookup against the owner's current account settings, which may
       well have changed since this was logged. */
    const putterMax = s.putterMax;
    const driverMax = s.driverMax;
    const putts = s.p15.concat(s.p25);
    const net = s.bh.concat(s.fh);
    const row = [s.date, s.displayName]
      .concat(padCells(s.p15, pSets), [sum(s.p15), pctCell(s.p15, putterMax)])
      .concat(padCells(s.p25, pSets), [sum(s.p25), pctCell(s.p25, putterMax)])
      .concat([sum(putts), pctCell(putts, putterMax)])
      .concat(padCells(s.bh, dSets), [sum(s.bh)])
      .concat(padCells(s.fh, dSets), [sum(s.fh)])
      .concat([sum(net), pctCell(net, driverMax)])
      .concat(['"' + String(s.notes || '').replace(/"/g, '""') + '"']);
    lines.push(row.join(','));
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="disc-golf-log-${new Date().toISOString().slice(0, 10)}.csv"`
  );
  res.send(lines.join('\n'));
});

/* POST /api/import — a deliberate restore from a backup file, not an
   offline-sync push, so every session is validated and applied as-is: no
   client updatedAt to compare against, no skip/merge conflict logic.
   "merge" upserts the file's sessions and leaves everything else alone;
   "replace" additionally tombstones every session the file doesn't mention. */
router.post('/import', (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.mode !== 'merge' && body.mode !== 'replace') {
      return bad(res, 'mode must be "merge" or "replace"');
    }
    if (!Array.isArray(body.sessions)) return bad(res, 'sessions must be an array');

    const snapshots = {};
    const sessions = body.sessions.map((raw) => {
      const lookupDate = raw && typeof raw.date === 'string' ? raw.date : null;
      const { limits, snapshot } = resolveLimitsAndSnapshot(req.user.id, lookupDate, req.user);
      const s = parseSession(raw, null, limits);
      if (snapshot) snapshots[s.date] = snapshot;
      return s;
    });
    const applied = db.applyImport(req.user.id, sessions, body.mode, snapshots);
    res.json({ serverTime: db.nowIso(), applied });
  } catch (err) { next(err); }
});

module.exports = router;
