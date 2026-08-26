/* store.js — offline-first storage for the training log.
 *
 * localStorage stays the thing the UI reads and writes, so logging a session
 * standing at a basket with no signal is still instant and still works. Every
 * change also lands in an outbox, and the outbox is pushed to the server the
 * next time the network is there.
 *
 * app.js talks to this through exactly two calls it already made — read() and
 * write(list) — so the UI code did not have to learn about the network. write()
 * diffs the incoming list against the last one it saw and derives the outbox
 * entries itself.
 *
 * Load order matters: store.js BEFORE app.js.
 */
(function (global) {
  'use strict';

  /* Namespaced per logged-in user, so a shared device doesn't mix accounts
     — configure(username) must run before read()/write()/start(). Until
     it does, these fall back to the pre-multi-user keys (harmless: nothing
     calls read/write/start before boot resolves who's logged in). */
  var namespace = '';
  var CACHE_KEY, OUTBOX_KEY, META_KEY;
  function deriveKeys() {
    var suffix = namespace ? '.' + namespace : '';
    CACHE_KEY  = 'dgTrainingLog.v2' + suffix;
    OUTBOX_KEY = 'dgTrainingLog.outbox.v1' + suffix;
    META_KEY   = 'dgTrainingLog.meta.v1' + suffix;
  }
  deriveKeys();
  function configure(username) {
    namespace = username || '';
    deriveKeys();
    lastSeen = null;   // force read() to re-snapshot from the newly-namespaced cache
  }

  var LEGACY_KEY = 'dgTrainingLog.v1';        // pre-server single-device data, pre-dates namespacing

  var STATIONS = { p15: 5, p25: 5, bh: 5, fh: 5 };
  var API = '/api';
  var RETRY_MS = 15000;

  /* ------------------------------------------------------ raw storage */
  var mem = {};          // fallback when localStorage throws (private windows)
  var storageBroken = false;

  function warnStorage() {
    storageBroken = true;
    var el = document.getElementById('storageWarn');
    if (el) el.hidden = false;
  }

  function lsGet(key, fallback) {
    if (storageBroken) return mem[key] !== undefined ? mem[key] : fallback;
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      warnStorage();
      return mem[key] !== undefined ? mem[key] : fallback;
    }
  }

  function lsSet(key, value) {
    mem[key] = value;
    if (storageBroken) return;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      warnStorage();
    }
  }

  /* ------------------------------------------------------------ utils */
  function nowIso() { return new Date().toISOString(); }

  function byDate(list) {
    var map = {};
    for (var i = 0; i < list.length; i++) map[list[i].date] = list[i];
    return map;
  }

  /* Comparable content only — updatedAt is deliberately excluded so that
     re-saving an identical session does not generate an outbox entry. */
  function fingerprint(s) {
    var parts = [s.notes || ''];
    for (var k in STATIONS) {
      if (!STATIONS.hasOwnProperty(k)) continue;
      parts.push(k + ':' + (s[k] || []).map(function (v) {
        return v === null || v === undefined ? '' : v;
      }).join(','));
    }
    return parts.join('|');
  }

  function sortByDate(list) {
    return list.slice().sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    });
  }

  /* ----------------------------------------------------------- outbox */
  /* Keyed by date so ten edits to one session collapse into one push. */
  function outbox() { return lsGet(OUTBOX_KEY, {}); }
  function setOutbox(o) { lsSet(OUTBOX_KEY, o); }

  function queueUpsert(session) {
    var o = outbox();
    o[session.date] = { type: 'upsert', session: session, stamp: session.updatedAt };
    setOutbox(o);
  }

  function queueDelete(date, deletedAt) {
    var o = outbox();
    o[date] = { type: 'delete', date: date, stamp: deletedAt };
    setOutbox(o);
  }

  function pendingCount() { return Object.keys(outbox()).length; }

  /* ------------------------------------------------------------- meta */
  function meta() { return lsGet(META_KEY, { since: null, lastSyncAt: null, migrated: false }); }
  function setMeta(m) { lsSet(META_KEY, m); }

  /* -------------------------------------------------------- migration */
  /* One-time lift of pre-server localStorage data into the v2 cache. The
     local copy is the only copy that exists at that point, so it is stamped
     now and queued for upload rather than being treated as stale. */
  function migrateLegacy() {
    var m = meta();
    if (m.migrated) return;
    var legacy = lsGet(LEGACY_KEY, null);
    m.migrated = true;
    setMeta(m);
    if (!legacy || !legacy.length) return;

    var stamped = legacy.map(function (s) {
      var copy = JSON.parse(JSON.stringify(s));
      copy.updatedAt = copy.updatedAt || nowIso();
      return copy;
    });
    lsSet(CACHE_KEY, sortByDate(stamped));
    stamped.forEach(queueUpsert);
    console.log('[store] migrated ' + stamped.length + ' session(s) from ' + LEGACY_KEY);
  }

  /* ------------------------------------------------------------- core */
  var listeners = [];
  var lastSeen = null;      // snapshot write() diffs against
  var flushTimer = null;
  var inFlight = false;

  function read() {
    var list = sortByDate(lsGet(CACHE_KEY, []));
    if (lastSeen === null) lastSeen = byDate(list);
    return list;
  }

  /* app.js hands back its whole in-memory array after every mutation. Diff it
     against the previous snapshot to work out what actually changed. */
  function write(list) {
    var next = byDate(list);
    var prev = lastSeen || {};
    var stamped = [];
    var date;

    for (date in next) {
      if (!next.hasOwnProperty(date)) continue;
      var s = next[date];
      var was = prev[date];
      if (!was || fingerprint(was) !== fingerprint(s)) {
        s.updatedAt = nowIso();
        queueUpsert(JSON.parse(JSON.stringify(s)));
      } else if (!s.updatedAt) {
        s.updatedAt = was.updatedAt;
      }
      stamped.push(s);
    }

    for (date in prev) {
      if (!prev.hasOwnProperty(date)) continue;
      if (!next[date]) queueDelete(date, nowIso());
    }

    var sorted = sortByDate(stamped);
    lsSet(CACHE_KEY, sorted);
    lastSeen = byDate(JSON.parse(JSON.stringify(sorted)));
    scheduleFlush(0);
  }

  /* Applied when the server sends changes back. Same last-write-wins rules
     the server uses, so both sides converge on the same answer. */
  function applyRemote(sessions, deletions) {
    var cache = byDate(read());
    var changed = false;
    var i, s;

    for (i = 0; i < (sessions || []).length; i++) {
      s = sessions[i];
      var mine = cache[s.date];
      if (mine && mine.updatedAt && mine.updatedAt >= s.updatedAt) continue;
      cache[s.date] = s;
      changed = true;
    }

    for (i = 0; i < (deletions || []).length; i++) {
      var d = deletions[i];
      var local = cache[d.date];
      if (!local) continue;
      if (local.updatedAt && local.updatedAt > d.deletedAt) continue;
      delete cache[d.date];
      changed = true;
    }

    if (!changed) return false;

    var list = sortByDate(Object.keys(cache).map(function (k) { return cache[k]; }));
    lsSet(CACHE_KEY, list);
    lastSeen = byDate(JSON.parse(JSON.stringify(list)));
    return true;
  }

  /* --------------------------------------------------------- roster
     Full-visibility read: everyone's sessions, tagged with userId/username.
     Deliberately kept OUT of the outbox/diff machinery above — read() and
     write() represent only the logged-in user's own sessions, the ones
     that flow through sync(). This is a separate, read-only, non-diffed
     cache: nothing here ever gets queued or pushed. Not namespaced per
     viewer — the same "everyone" data applies regardless of who's asking. */
  var ALL_KEY = 'dgTrainingLog.all.v1';
  var rosterListeners = [];
  function onRosterChange(fn) { rosterListeners.push(fn); }
  function notifyRoster() {
    rosterListeners.forEach(function (fn) { try { fn(); } catch (e) { console.error(e); } });
  }

  function readRoster() { return lsGet(ALL_KEY, []); }

  function syncRoster() {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve(false);
    return fetch(API + '/sessions').then(function (res) {
      if (!res.ok) throw new Error('roster fetch failed: HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      lsSet(ALL_KEY, data.sessions || []);
      notifyRoster();
      return true;
    }).catch(function (err) {
      console.warn('[store] roster: ' + (err.message || err));
      return false;
    });
  }

  /* ------------------------------------------------------------- sync */
  function scheduleFlush(delay) {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(function () { flushTimer = null; sync(); }, delay || 0);
  }

  function sync() {
    if (inFlight) return Promise.resolve(false);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      emit();
      return Promise.resolve(false);
    }

    inFlight = true;
    var snapshot = outbox();
    var m = meta();

    var payload = { since: m.since, sessions: [], deletions: [] };
    for (var date in snapshot) {
      if (!snapshot.hasOwnProperty(date)) continue;
      var entry = snapshot[date];
      if (entry.type === 'delete') payload.deletions.push({ date: date, deletedAt: entry.stamp });
      else payload.sessions.push(entry.session);
    }

    emit();

    return fetch(API + '/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (!res.ok) throw new Error('sync failed: HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      /* Drop only the entries that were actually sent and have not been
         re-queued since — anything edited mid-flight keeps its place. */
      var current = outbox();
      for (var d in snapshot) {
        if (!snapshot.hasOwnProperty(d)) continue;
        if (current[d] && current[d].stamp === snapshot[d].stamp) delete current[d];
      }
      setOutbox(current);

      var touched = applyRemote(data.sessions, data.deletions);
      var mm = meta();
      mm.since = data.serverTime;
      mm.lastSyncAt = data.serverTime;
      setMeta(mm);

      lastError = null;
      emit();
      if (touched) notify();
      syncRoster();   // opportunistic: we just proved the network is up
      return true;
    }).catch(function (err) {
      lastError = err.message || String(err);
      console.warn('[store] ' + lastError);
      emit();
      if (pendingCount()) scheduleFlush(RETRY_MS);
      return false;
    }).then(function (ok) {
      inFlight = false;
      emit();
      return ok;
    });
  }

  var lastError = null;

  function status() {
    return {
      online: typeof navigator === 'undefined' || navigator.onLine !== false,
      syncing: inFlight,
      pending: pendingCount(),
      lastSyncAt: meta().lastSyncAt,
      error: lastError,
      storageBroken: storageBroken
    };
  }

  /* ---------------------------------------------------------- events */
  var statusListeners = [];
  function onStatus(fn) { statusListeners.push(fn); }
  function emit() {
    var s = status();
    statusListeners.forEach(function (fn) { try { fn(s); } catch (e) { console.error(e); } });
  }

  /* Fired when the server changed the cache under the UI's feet — app.js
     re-reads and re-renders. */
  function onChange(fn) { listeners.push(fn); }
  function notify() {
    listeners.forEach(function (fn) { try { fn(); } catch (e) { console.error(e); } });
  }

  /* ------------------------------------------------------------ boot */
  function start() {
    migrateLegacy();
    read();
    sync();
    syncRoster();

    global.addEventListener('online', function () { scheduleFlush(0); });
    global.addEventListener('offline', emit);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) scheduleFlush(0);
    });
  }

  global.DGStore = {
    configure: configure,
    read: read,
    write: write,
    sync: sync,
    status: status,
    onChange: onChange,
    onStatus: onStatus,
    readRoster: readRoster,
    syncRoster: syncRoster,
    onRosterChange: onRosterChange,
    start: start,
    _internals: { outbox: outbox, meta: meta, fingerprint: fingerprint, applyRemote: applyRemote }
  };
})(window);
