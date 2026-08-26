'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const db = require('../server/db');
const { parseSession, ValidationError } = require('../server/shape');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'disc-test-'));
const FILE = path.join(TMP, 'test.sqlite');

const full = (date, over = {}) => Object.assign({
  date,
  p15: [18, 17, 16, 15, 14],
  p25: [11, 10, 9, 8, 7],
  bh:  [7, 6, 8, 7, 6],
  fh:  [5, 4, 6, 5, 4],
  notes: '',
  updatedAt: null
}, over);

test.before(() => { db.open(FILE); });
test.after(() => { db.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('migration is idempotent', () => {
  db.migrate();
  db.migrate();
  const rows = db.handle().prepare('SELECT version, name FROM schema_migrations').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, 1);
});

test('null sets round-trip as null, zeros round-trip as zero', () => {
  const s = parseSession(full('2026-01-05', { p15: [20, null, 0, null, 12] }), null);
  db.upsertSession(s);
  const got = db.getSession('2026-01-05');
  assert.deepEqual(got.p15, [20, null, 0, null, 12]);
  assert.equal(got.p25.length, 5);
});

test('re-saving the same date updates instead of duplicating', () => {
  db.upsertSession(parseSession(full('2026-01-06', { notes: 'first' }), null));
  const a = db.getSession('2026-01-06');
  db.upsertSession(parseSession(full('2026-01-06', { notes: 'second', p15: [1, 2, 3, 4, 5] }), null));
  const b = db.getSession('2026-01-06');
  assert.equal(db.stats().sessions, 2);            // 01-05 and 01-06 only
  assert.equal(b.notes, 'second');
  assert.deepEqual(b.p15, [1, 2, 3, 4, 5]);
  assert.ok(b.updatedAt >= a.updatedAt);
  const orphans = db.handle().prepare(
    'SELECT COUNT(*) n FROM session_sets WHERE session_id NOT IN (SELECT id FROM sessions)'
  ).get().n;
  assert.equal(orphans, 0);
});

test('the CHECK constraint refuses an out-of-range make at the SQL level', () => {
  const id = db.handle().prepare('SELECT id FROM sessions WHERE date = ?').get('2026-01-06').id;
  const ins = db.handle().prepare(
    'INSERT INTO session_sets (session_id, station, set_index, made) VALUES (?, ?, ?, ?)'
  );
  assert.throws(() => ins.run(id, 'bh', 4, 13), /CHECK/i);   // net max is 12
  assert.throws(() => ins.run(id, 'p15', 4, 21), /CHECK/i);  // putting max is 20
  assert.throws(() => ins.run(id, 'xx', 0, 1), /CHECK/i);    // unknown station
});

test('deleting cascades the sets and leaves a tombstone', () => {
  const existed = db.deleteSession('2026-01-05', db.nowIso());
  assert.equal(existed, true);
  assert.equal(db.getSession('2026-01-05'), null);
  const left = db.handle().prepare(
    'SELECT COUNT(*) n FROM session_sets s WHERE NOT EXISTS (SELECT 1 FROM sessions x WHERE x.id = s.session_id)'
  ).get().n;
  assert.equal(left, 0, 'foreign_keys pragma is off — the cascade did not fire');
  assert.equal(db.listDeletions().filter((d) => d.date === '2026-01-05').length, 1);
});

test('re-logging a deleted date clears its tombstone', () => {
  db.upsertSession(parseSession(full('2026-01-05'), null));
  assert.ok(db.getSession('2026-01-05'));
  assert.equal(db.listDeletions().filter((d) => d.date === '2026-01-05').length, 0);
});

test('listSessions(since) returns only what changed after it', () => {
  // Anchored on a real server stamp, so a same-millisecond tie would fail here.
  const mark = db.upsertSession(parseSession(full('2026-01-31'), null)).session.updatedAt;
  db.upsertSession(parseSession(full('2026-02-01'), null));
  const changed = db.listSessions(mark).map((s) => s.date);
  assert.deepEqual(changed, ['2026-02-01']);
  assert.ok(db.listSessions().length >= 3);
});

test('two writes in the same millisecond get distinct, increasing stamps', () => {
  const a = db.upsertSession(parseSession(full('2026-02-02'), null)).session.updatedAt;
  const b = db.upsertSession(parseSession(full('2026-02-03'), null)).session.updatedAt;
  assert.ok(b > a, 'server stamps must be strictly increasing');
  assert.deepEqual(db.listSessions(a).map((s) => s.date), ['2026-02-03']);
});

test('sync: a newer client write wins, an older one is skipped', () => {
  const old = new Date(Date.now() - 60000).toISOString();
  const fresh = new Date(Date.now() - 1000).toISOString();

  db.upsertSession(parseSession(full('2026-03-01', { notes: 'server', updatedAt: fresh }), null),
    { stampNow: false });

  let r = db.applySync({ sessions: [parseSession(full('2026-03-01', { notes: 'stale', updatedAt: old }), null)] });
  assert.deepEqual(r.upserted, []);
  assert.equal(r.skipped[0].reason, 'server-newer');
  assert.equal(db.getSession('2026-03-01').notes, 'server');

  const newer = new Date().toISOString();
  r = db.applySync({ sessions: [parseSession(full('2026-03-01', { notes: 'phone', updatedAt: newer }), null)] });
  assert.deepEqual(r.upserted, ['2026-03-01']);
  assert.equal(db.getSession('2026-03-01').notes, 'phone');
});

test('sync: a tombstone beats an older copy still sitting in an outbox', () => {
  const written = new Date(Date.now() - 60000).toISOString();
  db.upsertSession(parseSession(full('2026-04-01', { updatedAt: written }), null), { stampNow: false });
  db.deleteSession('2026-04-01', new Date(Date.now() - 30000).toISOString());

  const r = db.applySync({
    sessions: [parseSession(full('2026-04-01', { updatedAt: written }), null)]
  });
  assert.equal(r.skipped[0].reason, 'deleted-on-server');
  assert.equal(db.getSession('2026-04-01'), null);
});

test('sync: an edit made after the delete resurrects the session', () => {
  const later = new Date().toISOString();
  const r = db.applySync({
    sessions: [parseSession(full('2026-04-01', { notes: 'back', updatedAt: later }), null)]
  });
  assert.deepEqual(r.upserted, ['2026-04-01']);
  assert.equal(db.getSession('2026-04-01').notes, 'back');
});

test('sync: a delete older than the server copy is refused', () => {
  db.upsertSession(parseSession(full('2026-05-01'), null));
  const r = db.applySync({ deletions: [{ date: '2026-05-01', deletedAt: new Date(Date.now() - 90000).toISOString() }] });
  assert.deepEqual(r.deleted, []);
  assert.ok(db.getSession('2026-05-01'));
});

test('ISO timestamps compare correctly as strings', () => {
  const a = new Date(1).toISOString();
  const b = new Date(2).toISOString();
  assert.equal(a.length, b.length, 'toISOString must be fixed width for < to be chronological');
  assert.ok(a < b);
});

test('validation refuses what the client should never send', () => {
  const bad = (over, re) => assert.throws(() => parseSession(full('2026-06-01', over), null), re);
  bad({ p15: [21, null, null, null, null] }, ValidationError);   // over the max
  bad({ bh: [13, null, null, null, null] }, ValidationError);
  bad({ p15: [-1, null, null, null, null] }, ValidationError);
  bad({ p15: ['12', null, null, null, null] }, ValidationError); // string, not int
  bad({ p15: [1.5, null, null, null, null] }, ValidationError);
  bad({ notes: 'x'.repeat(4001) }, ValidationError);
  assert.throws(() => parseSession(full('2026-02-30'), null), /YYYY-MM-DD/);
  assert.throws(() => parseSession({ date: '2026-06-01' }, null), /no sets recorded/);
});

test('a client clock running fast is clamped to now', () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const s = parseSession(full('2026-06-02', { updatedAt: future }), null);
  assert.ok(s.updatedAt <= new Date().toISOString());
});
