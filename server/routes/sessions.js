'use strict';

const express = require('express');
const db = require('../db');
const { parseSession, isIsoDate, ValidationError } = require('../shape');

const router = express.Router();

function bad(res, message) { return res.status(400).json({ error: message }); }

/* GET /api/health — also what the Docker healthcheck hits. */
router.get('/health', (req, res) => {
  res.json({ ok: true, serverTime: db.nowIso(), ...db.stats() });
});

/* GET /api/sessions[?since=ISO] — oldest first. */
router.get('/sessions', (req, res) => {
  const since = req.query.since;
  if (since !== undefined && isNaN(new Date(since))) return bad(res, 'since must be ISO-8601');
  const serverTime = db.nowIso();
  res.json({ serverTime, sessions: db.listSessions(since) });
});

router.get('/sessions/:date', (req, res) => {
  if (!isIsoDate(req.params.date)) return bad(res, 'date must be YYYY-MM-DD');
  const s = db.getSession(req.params.date);
  if (!s) return res.status(404).json({ error: 'no session on that date' });
  res.json(s);
});

/* PUT /api/sessions/:date — upsert, idempotent. This is the plain
   "Save session" path: a deliberate write from the UI always wins, and the
   server stamps updatedAt. Conflict resolution lives in POST /sync, not here. */
router.put('/sessions/:date', (req, res, next) => {
  try {
    const session = parseSession(req.body, req.params.date);
    const { session: stored, created } = db.upsertSession(session, { stampNow: true });
    res.status(created ? 201 : 200).json(stored);
  } catch (err) { next(err); }
});

router.delete('/sessions/:date', (req, res) => {
  if (!isIsoDate(req.params.date)) return bad(res, 'date must be YYYY-MM-DD');
  const existed = db.deleteSession(req.params.date, db.nowIso());
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
    for (const raw of Array.isArray(body.sessions) ? body.sessions : []) {
      const s = parseSession(raw, null);
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

    const applied = db.applySync({ sessions: incoming, deletions });

    /* Reply with everything the caller has not seen. Read AFTER applying so
       the client's own writes come back stamped and it can drop its outbox. */
    res.json({
      serverTime,
      applied,
      sessions: db.listSessions(since || undefined),
      deletions: db.listDeletions(since || undefined)
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

router.get('/export.csv', (req, res) => {
  const sessions = db.listSessions();
  const head = ['Date',
    '15ft Set 1', '15ft Set 2', '15ft Set 3', '15ft Set 4', '15ft Set 5', '15ft Made', '15ft %',
    '25ft Set 1', '25ft Set 2', '25ft Set 3', '25ft Set 4', '25ft Set 5', '25ft Made', '25ft %',
    'Putts Made', 'Putt %',
    'BH Rd 1', 'BH Rd 2', 'BH Rd 3', 'BH Rd 4', 'BH Rd 5', 'BH In',
    'FH Rd 1', 'FH Rd 2', 'FH Rd 3', 'FH Rd 4', 'FH Rd 5', 'FH In',
    'Net In', 'Net %', 'Notes'];

  const lines = [head.join(',')];
  for (const s of sessions) {
    const putts = s.p15.concat(s.p25);
    const net = s.bh.concat(s.fh);
    const row = [s.date]
      .concat(s.p15.map(csvCell), [sum(s.p15), pctCell(s.p15, 20)])
      .concat(s.p25.map(csvCell), [sum(s.p25), pctCell(s.p25, 20)])
      .concat([sum(putts), pctCell(putts, 20)])
      .concat(s.bh.map(csvCell), [sum(s.bh)])
      .concat(s.fh.map(csvCell), [sum(s.fh)])
      .concat([sum(net), pctCell(net, 12)])
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

    const sessions = body.sessions.map((raw) => parseSession(raw, null));
    const applied = db.applyImport(sessions, body.mode);
    res.json({ serverTime: db.nowIso(), applied });
  } catch (err) { next(err); }
});

module.exports = router;
