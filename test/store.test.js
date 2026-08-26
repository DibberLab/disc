'use strict';

/* public/store.js is a browser script — it reaches for `window`,
   `localStorage`, `fetch`, `navigator` as free globals. Rather than pull in
   jsdom for one file, each test loads the source into its own `vm` context
   with those stubbed. That also sidesteps a real hazard: store.js schedules
   its outbox flush with `setTimeout(fn, 0)`, and a stray real timer from one
   test firing during the next test — against that test's fetch/localStorage
   mocks — would be a source of flaky, hard-to-reproduce failures. Giving
   `setTimeout` a no-op inside the sandbox means nothing auto-flushes; tests
   that care about a sync happening call DGStore.sync() themselves. */

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.join(__dirname, '../public/store.js'), 'utf8');

function makeLocalStorage() {
  const data = new Map();
  return {
    getItem(k) { return data.has(k) ? data.get(k) : null; },
    setItem(k, v) { data.set(k, String(v)); },
    removeItem(k) { data.delete(k); }
  };
}

function freshStore({ localStorage, fetchImpl, online = true } = {}) {
  const ls = localStorage || makeLocalStorage();
  const sandbox = {
    localStorage: ls,
    document: { getElementById() { return null; }, addEventListener() {} },
    navigator: { onLine: online },
    fetch: fetchImpl || (() => Promise.reject(new Error('fetch not configured for this test'))),
    setTimeout() { return 0; },   // no auto-flush — tests call DGStore.sync() themselves
    clearTimeout() {},
    addEventListener() {},        // global.addEventListener, called from start()
    console
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'store.js' });
  return { DGStore: sandbox.DGStore, localStorage: ls };
}

const session = (date, over = {}) => Object.assign({
  date,
  p15: [1, null, null, null, null],
  p25: [null, null, null, null, null],
  bh: [null, null, null, null, null],
  fh: [null, null, null, null, null],
  notes: '',
  updatedAt: null
}, over);

function okJson(body) {
  return () => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
}

/* ------------------------------------------------------------- outbox */

test('ten edits to one session collapse into a single outbox entry', () => {
  const { DGStore } = freshStore();
  for (let i = 1; i <= 10; i++) {
    DGStore.write([session('2026-01-01', { notes: 'edit ' + i })]);
  }
  const ob = DGStore._internals.outbox();
  assert.equal(Object.keys(ob).length, 1);
  assert.equal(ob['2026-01-01'].type, 'upsert');
  assert.equal(ob['2026-01-01'].session.notes, 'edit 10');
});

test('re-saving an identical session does not requeue it', () => {
  const { DGStore } = freshStore();
  DGStore.write([session('2026-01-02', { notes: 'same' })]);
  const first = DGStore._internals.outbox()['2026-01-02'].stamp;

  DGStore.write([session('2026-01-02', { notes: 'same' })]);
  const second = DGStore._internals.outbox()['2026-01-02'].stamp;

  assert.equal(first, second, 'an unchanged fingerprint must not bump the queued stamp');
});

test('removing a session that was queued for upsert collapses to one delete entry', () => {
  const { DGStore } = freshStore();
  DGStore.write([session('2026-01-03')]);
  assert.equal(DGStore._internals.outbox()['2026-01-03'].type, 'upsert');

  DGStore.write([]); // the session is gone from the list app.js hands back
  const ob = DGStore._internals.outbox();
  assert.equal(Object.keys(ob).length, 1);
  assert.equal(ob['2026-01-03'].type, 'delete');
});

test('editing two different dates queues two independent outbox entries', () => {
  const { DGStore } = freshStore();
  DGStore.write([session('2026-01-04'), session('2026-01-05')]);
  const ob = DGStore._internals.outbox();
  assert.deepEqual(Object.keys(ob).sort(), ['2026-01-04', '2026-01-05']);
});

/* -------------------------------------------------------- legacy v1 migration */

test('legacy v1 data migrates into the cache and queues for upload, once', () => {
  const ls = makeLocalStorage();
  ls.setItem('dgTrainingLog.v1', JSON.stringify([
    session('2025-01-01', { notes: 'legacy', p15: [10, null, null, null, null] })
  ]));
  const { DGStore } = freshStore({ localStorage: ls, fetchImpl: () => Promise.reject(new Error('offline')) });

  DGStore.start();

  const cached = DGStore.read();
  assert.equal(cached.length, 1);
  assert.equal(cached[0].date, '2025-01-01');
  assert.ok(cached[0].updatedAt, 'a migrated session must be stamped so it can be ordered');

  const ob = DGStore._internals.outbox();
  assert.equal(Object.keys(ob).length, 1, 'the migrated session must be queued for its first upload');
  assert.equal(ob['2025-01-01'].type, 'upsert');
  assert.equal(DGStore._internals.meta().migrated, true);

  // a second start() (e.g. the next page load) must not re-migrate or requeue
  DGStore.start();
  assert.equal(DGStore.read().length, 1);
  assert.equal(Object.keys(DGStore._internals.outbox()).length, 1);
});

test('legacy migration preserves an existing updatedAt instead of overwriting it', () => {
  const ls = makeLocalStorage();
  const stamp = '2020-06-01T00:00:00.000Z';
  ls.setItem('dgTrainingLog.v1', JSON.stringify([session('2025-02-02', { updatedAt: stamp })]));
  const { DGStore } = freshStore({ localStorage: ls, fetchImpl: () => Promise.reject(new Error('offline')) });

  DGStore.start();
  assert.equal(DGStore.read()[0].updatedAt, stamp);
});

test('migrating with no legacy data present is a no-op, but still marks migrated', () => {
  const { DGStore } = freshStore({ fetchImpl: () => Promise.reject(new Error('offline')) });
  DGStore.start();
  assert.equal(DGStore.read().length, 0);
  assert.equal(Object.keys(DGStore._internals.outbox()).length, 0);
  assert.equal(DGStore._internals.meta().migrated, true);
});

/* ------------------------------------------------------------ applyRemote */

test('applyRemote: a newer remote session overwrites the local copy', () => {
  const ls = makeLocalStorage();
  ls.setItem('dgTrainingLog.v2', JSON.stringify([
    session('2026-02-01', { notes: 'old', updatedAt: '2026-02-01T00:00:00.000Z' })
  ]));
  const { DGStore } = freshStore({ localStorage: ls });

  const changed = DGStore._internals.applyRemote(
    [session('2026-02-01', { notes: 'new', updatedAt: '2026-02-01T00:00:01.000Z' })], []
  );
  assert.equal(changed, true);
  assert.equal(DGStore.read()[0].notes, 'new');
});

test('applyRemote: a stale remote session does not clobber a newer local edit', () => {
  const ls = makeLocalStorage();
  ls.setItem('dgTrainingLog.v2', JSON.stringify([
    session('2026-02-02', { notes: 'mine', updatedAt: '2026-02-02T00:00:05.000Z' })
  ]));
  const { DGStore } = freshStore({ localStorage: ls });

  const changed = DGStore._internals.applyRemote(
    [session('2026-02-02', { notes: 'stale', updatedAt: '2026-02-02T00:00:00.000Z' })], []
  );
  assert.equal(changed, false);
  assert.equal(DGStore.read()[0].notes, 'mine');
});

test('applyRemote: a remote deletion removes a local session it postdates', () => {
  const ls = makeLocalStorage();
  ls.setItem('dgTrainingLog.v2', JSON.stringify([
    session('2026-02-03', { updatedAt: '2026-02-03T00:00:00.000Z' })
  ]));
  const { DGStore } = freshStore({ localStorage: ls });

  const changed = DGStore._internals.applyRemote([], [{ date: '2026-02-03', deletedAt: '2026-02-03T00:00:05.000Z' }]);
  assert.equal(changed, true);
  assert.equal(DGStore.read().length, 0);
});

test('applyRemote: a local edit made after a remote delete resurrects the session', () => {
  const ls = makeLocalStorage();
  ls.setItem('dgTrainingLog.v2', JSON.stringify([
    session('2026-02-04', { notes: 'edited after delete', updatedAt: '2026-02-04T00:00:10.000Z' })
  ]));
  const { DGStore } = freshStore({ localStorage: ls });

  const changed = DGStore._internals.applyRemote([], [{ date: '2026-02-04', deletedAt: '2026-02-04T00:00:05.000Z' }]);
  assert.equal(changed, false);
  assert.equal(DGStore.read().length, 1);
  assert.equal(DGStore.read()[0].notes, 'edited after delete');
});

test('applyRemote: nothing to apply reports no change', () => {
  const { DGStore } = freshStore();
  assert.equal(DGStore._internals.applyRemote([], []), false);
  assert.equal(DGStore._internals.applyRemote(undefined, undefined), false);
});

/* ------------------------------------------------------------------ sync */

test('sync() reports syncing:false once it settles (regression: emit was missing after inFlight reset)', async () => {
  const { DGStore } = freshStore({
    fetchImpl: okJson({ serverTime: '2026-03-01T00:00:00.000Z', sessions: [], deletions: [] })
  });
  const seen = [];
  DGStore.onStatus((s) => seen.push(s));

  await DGStore.sync();

  assert.equal(DGStore.status().syncing, false);
  assert.ok(seen.some((s) => s.syncing === false), 'no status update ever reported syncing:false');
});

test('sync() does not touch the network while offline', async () => {
  const { DGStore } = freshStore({ online: false, fetchImpl: () => { throw new Error('fetch must not be called while offline'); } });
  DGStore.write([session('2026-03-05')]);

  const result = await DGStore.sync();

  assert.equal(result, false);
  assert.equal(DGStore.status().pending, 1);
});

test('a failed sync leaves the outbox entry queued and surfaces the error', async () => {
  const { DGStore } = freshStore({ fetchImpl: () => Promise.reject(new TypeError('network down')) });
  DGStore.write([session('2026-03-06')]);

  await DGStore.sync();

  assert.equal(DGStore.status().pending, 1);
  assert.match(DGStore.status().error, /network down/);
});

/* ------------------------------------------------------ per-user namespace */

test('configure(username) namespaces the cache so two accounts on one device do not mix', () => {
  const ls = makeLocalStorage();
  const { DGStore } = freshStore({ localStorage: ls });

  DGStore.configure('andy');
  DGStore.write([session('2026-08-01', { notes: "andy's" })]);

  DGStore.configure('riley');
  assert.equal(DGStore.read().length, 0, "switching users must not see andy's cache");
  DGStore.write([session('2026-08-01', { notes: "riley's" })]);

  DGStore.configure('andy');
  assert.equal(DGStore.read()[0].notes, "andy's", "switching back must not see riley's write");
});

/* ------------------------------------------------------------------ roster */

test('syncRoster caches the full-visibility list separately from the outbox cache', async () => {
  const everyone = [session('2026-08-10', { notes: 'mine' }), session('2026-08-11', { notes: 'theirs' })];
  const { DGStore } = freshStore({ fetchImpl: okJson({ serverTime: '2026-08-12T00:00:00.000Z', sessions: everyone }) });

  assert.deepEqual(DGStore.readRoster(), []);
  const ok = await DGStore.syncRoster();
  assert.equal(ok, true);
  assert.equal(DGStore.readRoster().length, 2);
  assert.equal(DGStore.read().length, 0, 'the roster fetch must not populate the outbox-diffed cache');
});

test('syncRoster does not touch the network while offline', async () => {
  const { DGStore } = freshStore({ online: false, fetchImpl: () => { throw new Error('fetch must not be called while offline'); } });
  const ok = await DGStore.syncRoster();
  assert.equal(ok, false);
});
