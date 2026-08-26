/* app.js — disc golf training log.
   Data model:  { date:'YYYY-MM-DD', p15:[5], p25:[5], bh:[5], fh:[5], notes:'' }
   Each array holds makes for that set, or null if the set wasn't thrown. */
(function () {
  'use strict';
  var GRIDS = {
    p15: { label: 'Set', max: 20, count: 5 },
    p25: { label: 'Set', max: 20, count: 5 },
    bh:  { label: 'Rd',  max: 12, count: 5 },
    fh:  { label: 'Rd',  max: 12, count: 5 }
  };
  var C = { p15: '#3fbd97', p25: '#e0a244', bh: '#5aa9e6', fh: '#d2634f' };

  /* ------------------------------------------------------------ storage
     Backed by store.js (loaded first). localStorage is still what the UI
     reads and writes, so the app works with no signal; store.js diffs each
     write and pushes it to the server when the network is back. */
  var Store = {
    read: function () { return DGStore.read(); },
    write: function (list) { DGStore.write(list); }
  };

  var sessions = Store.read();
  sortSessions();

  function sortSessions() {
    sessions.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  }

  /* -------------------------------------------------------------- utils */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function isoLocal(d) {
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function today() {
    return isoLocal(new Date());
  }
  function shortDate(iso) {
    var p = iso.split('-');
    return (+p[1]) + '/' + (+p[2]);
  }
  function longDate(iso) {
    var d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }
  function pct(v) { return v === null ? '—' : (v * 100).toFixed(1) + '%'; }
  function sum(arr) {
    return arr.reduce(function (a, v) { return v === null || v === undefined ? a : a + v; }, 0);
  }
  function thrown(arr, per) {
    return arr.reduce(function (a, v) { return v === null || v === undefined ? a : a + per; }, 0);
  }
  function rate(arr, per) {
    var t = thrown(arr, per);
    return t === 0 ? null : sum(arr) / t;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* -------------------------------------------------- session accessors */
  function putts(s) { return s.p15.concat(s.p25); }
  function netAll(s) { return s.bh.concat(s.fh); }
  function puttPct(s) { return rate(putts(s), 20); }
  function netPct(s) { return rate(netAll(s), 12); }
  function discsThrown(s) { return thrown(putts(s), 20) + thrown(netAll(s), 12); }

  /* --------------------------------------------------------- form build */
  function buildGrid(key) {
    var cfg = GRIDS[key];
    var mount = $('[data-grid="' + key + '"]');
    var html = '';
    for (var i = 0; i < cfg.count; i++) {
      var id = key + i;
      html +=
        '<div class="setcell" data-cell="' + id + '">' +
          '<label for="' + id + '">' + cfg.label + ' ' + (i + 1) + '</label>' +
          '<div class="stepper">' +
            '<button type="button" class="dec" data-target="' + id + '" aria-label="One fewer on ' + cfg.label + ' ' + (i + 1) + '">–</button>' +
            '<input id="' + id + '" type="number" inputmode="numeric" min="0" max="' + cfg.max + '" ' +
                   'placeholder="–" data-key="' + key + '" data-idx="' + i + '" data-max="' + cfg.max + '">' +
            '<button type="button" class="inc" data-target="' + id + '" aria-label="One more on ' + cfg.label + ' ' + (i + 1) + '">+</button>' +
          '</div>' +
        '</div>';
    }
    mount.innerHTML = html;
  }
  Object.keys(GRIDS).forEach(buildGrid);

  function readForm() {
    var s = { date: $('#date').value, p15: [], p25: [], bh: [], fh: [], notes: $('#notes').value.trim() };
    Object.keys(GRIDS).forEach(function (key) {
      for (var i = 0; i < GRIDS[key].count; i++) {
        var v = $('#' + key + i).value;
        s[key].push(v === '' ? null : Math.max(0, Math.min(GRIDS[key].max, parseInt(v, 10) || 0)));
      }
    });
    return s;
  }

  function fillForm(s) {
    $('#date').value = s ? s.date : today();
    $('#notes').value = s ? (s.notes || '') : '';
    Object.keys(GRIDS).forEach(function (key) {
      for (var i = 0; i < GRIDS[key].count; i++) {
        var v = s ? s[key][i] : null;
        $('#' + key + i).value = (v === null || v === undefined) ? '' : v;
      }
    });
    refreshForm();
  }

  function refreshForm() {
    var s = readForm();
    $$('input[data-key]').forEach(function (inp) {
      $('[data-cell="' + inp.id + '"]').classList.toggle('filled', inp.value !== '');
    });
    var pm = sum(putts(s)), pt = thrown(putts(s), 20);
    var nm = sum(netAll(s)), nt = thrown(netAll(s), 12);
    $('#liveP').innerHTML = pm + '<i>/' + pt + '</i>';
    $('#liveN').innerHTML = nm + '<i>/' + nt + '</i>';
    $('#livePpct').textContent = pt ? pct(pm / pt) : '—';
    $('#liveNpct').textContent = nt ? pct(nm / nt) : '—';

    var existing = find(s.date);
    $('#dateNote').textContent = existing
      ? 'A session is already saved for this date. Saving will replace it.'
      : '';
  }

  function find(date) {
    for (var i = 0; i < sessions.length; i++) if (sessions[i].date === date) return sessions[i];
    return null;
  }

  /* ------------------------------------------------------- form events */
  document.addEventListener('input', function (e) {
    if (e.target.matches('input[data-key], #date, #notes')) {
      if (e.target.dataset.key) {
        var max = +e.target.dataset.max;
        if (e.target.value !== '' && +e.target.value > max) e.target.value = max;
        if (e.target.value !== '' && +e.target.value < 0) e.target.value = 0;
      }
      refreshForm();
    }
  });

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.inc, .dec');
    if (!btn) return;
    var inp = document.getElementById(btn.dataset.target);
    var max = +inp.dataset.max;
    var cur = inp.value === '' ? -1 : parseInt(inp.value, 10);
    if (btn.classList.contains('inc')) inp.value = Math.min(max, cur + 1);
    else inp.value = cur <= 0 ? '' : cur - 1;
    refreshForm();
  });

  $('#save').addEventListener('click', function () {
    var s = readForm();
    var note = $('#saveNote');
    if (!s.date) {
      note.textContent = 'Pick a date first.';
      note.className = 'savenote bad';
      return;
    }
    if (discsThrown(s) === 0) {
      note.textContent = 'Nothing to save yet — fill in at least one set.';
      note.className = 'savenote bad';
      return;
    }
    var existing = find(s.date);
    if (existing) sessions[sessions.indexOf(existing)] = s;
    else sessions.push(s);
    sortSessions();
    Store.write(sessions);
    note.textContent = (existing ? 'Updated ' : 'Saved ') + longDate(s.date) + '.';
    note.className = 'savenote';
    renderHistory();
    renderAnalytics();
    refreshForm();
  });

  $('#reset').addEventListener('click', function () {
    fillForm(null);
    $('#saveNote').textContent = '';
  });

  /* ---------------------------------------------------------- tab logic */
  $$('.tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      $$('.tab').forEach(function (t) {
        t.classList.toggle('is-active', t === tab);
        t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
      });
      $$('.view').forEach(function (v) {
        v.classList.toggle('is-active', v.id === 'view-' + tab.dataset.view);
      });
      if (tab.dataset.view === 'analytics') renderAnalytics();
      window.scrollTo(0, 0);
    });
  });

  function goTo(view) {
    var t = $('.tab[data-view="' + view + '"]');
    if (t) t.click();
  }

  /* ------------------------------------------------------------ history */
  function renderHistory() {
    var mount = $('#historyMount');
    if (!sessions.length) {
      mount.innerHTML = '<div class="empty"><b>No sessions yet</b>' +
        'Log one on the first tab, or load the sample data to see what the charts do.</div>';
      return;
    }
    var rows = sessions.slice().reverse().map(function (s) {
      return '<tr>' +
        '<td>' + longDate(s.date) + '</td>' +
        '<td>' + sum(s.p15) + '<span style="color:var(--muted)">/' + thrown(s.p15, 20) + '</span></td>' +
        '<td>' + pct(rate(s.p15, 20)) + '</td>' +
        '<td>' + sum(s.p25) + '<span style="color:var(--muted)">/' + thrown(s.p25, 20) + '</span></td>' +
        '<td>' + pct(rate(s.p25, 20)) + '</td>' +
        '<td>' + sum(s.bh) + '</td>' +
        '<td>' + sum(s.fh) + '</td>' +
        '<td>' + pct(netPct(s)) + '</td>' +
        '<td class="notes">' + esc(s.notes || '') + '</td>' +
        '<td style="white-space:nowrap">' +
          '<button class="rowbtn" data-edit="' + s.date + '">Edit</button>' +
          '<button class="rowbtn del" data-del="' + s.date + '">Delete</button>' +
        '</td></tr>';
    }).join('');

    mount.innerHTML =
      '<div class="tablewrap"><table><thead><tr>' +
      '<th>Date</th><th>15 ft</th><th>15 ft %</th><th>25 ft</th><th>25 ft %</th>' +
      '<th>Net BH</th><th>Net FH</th><th>Net %</th><th>Notes</th><th></th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';

    $$('[data-edit]', mount).forEach(function (b) {
      b.addEventListener('click', function () {
        fillForm(find(b.dataset.edit));
        goTo('log');
      });
    });
    $$('[data-del]', mount).forEach(function (b) {
      b.addEventListener('click', function () {
        if (!confirm('Delete the session from ' + longDate(b.dataset.del) + '?')) return;
        sessions = sessions.filter(function (s) { return s.date !== b.dataset.del; });
        Store.write(sessions);
        renderHistory();
        renderAnalytics();
        refreshForm();
      });
    });
  }

  /* ------------------------------------------------------ import/export
     Export downloads straight from the server (the authoritative, merged
     copy across every device) instead of the local cache. Import posts to
     the server too: /api/import runs each session through the same
     shape.parseSession the rest of the API uses, so a hand-edited backup
     gets a real "p15[2] must be between 0 and 20" instead of silently
     landing wrong locally and diverging on the next sync. */
  $('#exportCsv').addEventListener('click', function () {
    window.location.href = '/api/export.csv';
  });

  $('#exportJson').addEventListener('click', function () {
    window.location.href = '/api/export.json';
  });

  $('#importJson').addEventListener('click', function () { $('#fileInput').click(); });

  $('#fileInput').addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var incoming;
      try {
        var data = JSON.parse(reader.result);
        incoming = Array.isArray(data) ? data : data.sessions;
        if (!Array.isArray(incoming)) throw new Error('shape');
      } catch (err) {
        alert("That file isn't a training-log backup. Pick the JSON file this app exported.");
        e.target.value = '';
        return;
      }

      fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessions: incoming, mode: 'merge' })
      }).then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) { var e2 = new Error(body.error || 'import failed'); e2.rejected = true; throw e2; }
          return body;
        });
      }).then(function (body) {
        return DGStore.sync().then(function () {
          sessions = Store.read();
          sortSessions();
          renderHistory(); renderAnalytics(); refreshForm();
          var n = body.applied.upserted.length;
          alert('Restored ' + n + ' session' + (n === 1 ? '' : 's') + '.');
        });
      }).catch(function (err) {
        alert(err.rejected
          ? 'Import failed: ' + err.message
          : "Couldn't reach the server to import. Check the connection and try again.");
      }).then(function () {
        e.target.value = '';
      });
    };
    reader.readAsText(file);
  });

  $('#wipe').addEventListener('click', function () {
    if (!sessions.length) return;
    if (!confirm('Delete all ' + sessions.length + ' sessions? Back up first if you might want them.')) return;
    sessions = [];
    Store.write(sessions);
    renderHistory(); renderAnalytics(); refreshForm();
  });

  $('#sample').addEventListener('click', function () {
    if (sessions.length && !confirm('This adds 21 made-up sessions on top of what you have. Continue?')) return;
    var out = [], base = new Date();
    for (var d = 27; d >= 0; d--) {
      if (d % 4 === 2) continue;                       // rest days
      var day = new Date(base.getTime() - d * 86400000);
      var iso = isoLocal(day);
      var prog = (28 - d) / 28;
      out.push({
        date: iso,
        p15: mk(5, 13 + prog * 3, 1.6, 20),
        p25: mk(5, 8 + prog * 3, 1.8, 20),
        bh: mk(5, 6 + prog * 2, 1.3, 12),
        fh: mk(5, 4 + prog * 2.5, 1.4, 12),
        notes: ''
      });
    }
    out.forEach(function (s) {
      var existing = find(s.date);
      if (existing) sessions[sessions.indexOf(existing)] = s; else sessions.push(s);
    });
    sortSessions();
    Store.write(sessions);
    renderHistory(); renderAnalytics(); refreshForm();
  });

  function mk(n, mean, spread, max) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var fatigue = i * 0.35;                          // slight late-round dropoff
      var v = Math.round(mean - fatigue + (Math.random() - 0.5) * 2 * spread);
      out.push(Math.max(0, Math.min(max, v)));
    }
    return out;
  }

  /* ---------------------------------------------------------- analytics */
  function rolling(values, win) {
    return values.map(function (_, i) {
      var slice = values.slice(Math.max(0, i - win + 1), i + 1).filter(function (v) { return v !== null; });
      if (!slice.length) return null;
      return slice.reduce(function (a, b) { return a + b; }, 0) / slice.length;
    });
  }

  function poolRate(key, per) {
    var made = 0, t = 0;
    sessions.forEach(function (s) { made += sum(s[key]); t += thrown(s[key], per); });
    return t === 0 ? null : made / t;
  }

  function windowRate(key, per, n) {
    var made = 0, t = 0;
    sessions.slice(-n).forEach(function (s) { made += sum(s[key]); t += thrown(s[key], per); });
    return t === 0 ? null : made / t;
  }

  function setAverages(key) {
    var out = [];
    for (var i = 0; i < 5; i++) {
      var vals = sessions.map(function (s) { return s[key][i]; }).filter(function (v) { return v !== null && v !== undefined; });
      out.push(vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : null);
    }
    return out;
  }

  function streak() {
    if (!sessions.length) return 0;
    var have = {};
    sessions.forEach(function (s) { have[s.date] = true; });
    var d = new Date(today() + 'T12:00:00');
    if (!have[today()]) d = new Date(d.getTime() - 86400000);
    var n = 0;
    while (true) {
      var iso = isoLocal(d);
      if (!have[iso]) break;
      n++;
      d = new Date(d.getTime() - 86400000);
    }
    return n;
  }

  function card(label, value, sub, cls) {
    return '<div class="card"><span class="eyebrow">' + label + '</span>' +
      '<b class="' + (cls || '') + '">' + value + '</b>' +
      (sub ? '<small>' + sub + '</small>' : '') + '</div>';
  }

  function delta(now, before) {
    if (now === null || before === null) return { text: '', cls: '' };
    var d = (now - before) * 100;
    return {
      text: (d >= 0 ? '+' : '') + d.toFixed(1) + ' pts vs all time',
      cls: d >= 0 ? 'up' : 'down'
    };
  }

  function renderAnalytics() {
    var mount = $('#analyticsMount');
    if (!sessions.length) {
      mount.innerHTML = '<div class="empty"><b>Nothing to chart yet</b>' +
        'Save a session and the numbers show up here. Want a preview? ' +
        'Load the sample data from the History tab.</div>';
      return;
    }

    var labels = sessions.map(function (s) { return shortDate(s.date); });
    var v15 = sessions.map(function (s) { return rate(s.p15, 20); });
    var v25 = sessions.map(function (s) { return rate(s.p25, 20); });
    var vbh = sessions.map(function (s) { return rate(s.bh, 12); });
    var vfh = sessions.map(function (s) { return rate(s.fh, 12); });

    var all15 = poolRate('p15', 20), all25 = poolRate('p25', 20);
    var last15 = windowRate('p15', 20, 10), last25 = windowRate('p25', 20, 10);
    var d15 = delta(last15, all15), d25 = delta(last25, all25);
    var totalPutts = sessions.reduce(function (a, s) { return a + thrown(putts(s), 20); }, 0);
    var madePutts = sessions.reduce(function (a, s) { return a + sum(putts(s)); }, 0);
    var best15 = Math.max.apply(null, sessions.map(function (s) { return sum(s.p15); }));
    var best25 = Math.max.apply(null, sessions.map(function (s) { return sum(s.p25); }));
    var st = streak();

    var html = '<div class="cards">' +
      card('Sessions', sessions.length, longDate(sessions[sessions.length - 1].date) + ' was the last one') +
      card('Current streak', st + (st === 1 ? ' day' : ' days'), st ? 'consecutive days logged' : 'log today to start one') +
      card('Putts thrown', totalPutts.toLocaleString(), madePutts.toLocaleString() + ' made all time') +
      card('15 ft · last 10', pct(last15), d15.text || ('all time ' + pct(all15)), d15.cls) +
      card('25 ft · last 10', pct(last25), d25.text || ('all time ' + pct(all25)), d25.cls) +
      card('Best 15 ft day', best15 + '<span style="font-size:16px;color:var(--muted)">/100</span>', 'personal best') +
      card('Best 25 ft day', best25 + '<span style="font-size:16px;color:var(--muted)">/100</span>', 'personal best') +
      card('Net · BH vs FH', pct(poolRate('bh', 12)) + ' / ' + pct(poolRate('fh', 12)), 'all-time hit rate') +
      '</div>';

    html += panel('putting', 'Putting make rate by session',
      'Dots are single sessions. The dashed lines are a 5-session average, which is the one to actually watch.',
      Charts.legend([
        { name: '15 ft', color: C.p15 }, { name: '25 ft', color: C.p25 },
        { name: '5-session average', color: '#6f8079' }
      ]));

    html += panel('fatigue', 'Average makes by set number',
      'If set 5 sits well under set 1, the back half of your round is where the work is.', '');

    html += panel('net', 'Net accuracy by session',
      'Share of the 12 discs that found the rectangle, backhand against forehand.',
      Charts.legend([{ name: 'Backhand', color: C.bh }, { name: 'Forehand', color: C.fh }]));

    html += panel('netround', 'Average net hits by round', 'Same fatigue question for the net work.', '');

    html += '<div class="panel"><h2>Practice calendar</h2>' +
      '<p class="sub">Last 18 weeks. Darker means more discs thrown that day.</p>' +
      '<div class="heatwrap"><div class="heat" id="heat"></div></div></div>';

    mount.innerHTML = html;

    Charts.line($('#chart-putting'), {
      labels: labels, yMax: 1, yTicks: 4, fmtY: function (v) { return Math.round(v * 100) + '%'; },
      fmtV: pct,
      series: [
        { name: '15 ft', color: C.p15, values: v15, width: 2 },
        { name: '25 ft', color: C.p25, values: v25, width: 2 },
        { name: '15 ft trend', color: C.p15, values: rolling(v15, 5), dashed: true, dots: false, width: 2 },
        { name: '25 ft trend', color: C.p25, values: rolling(v25, 5), dashed: true, dots: false, width: 2 }
      ]
    });

    Charts.bars($('#chart-fatigue'), {
      categories: ['Set 1', 'Set 2', 'Set 3', 'Set 4', 'Set 5'],
      yMax: 20, yTicks: 4, valueLabels: true,
      fmtV: function (v) { return v.toFixed(1); },
      series: [
        { name: '15 ft', color: C.p15, values: setAverages('p15') },
        { name: '25 ft', color: C.p25, values: setAverages('p25') }
      ],
      height: 260
    });

    Charts.line($('#chart-net'), {
      labels: labels, yMax: 1, yTicks: 4, fmtY: function (v) { return Math.round(v * 100) + '%'; },
      fmtV: pct,
      series: [
        { name: 'Backhand', color: C.bh, values: vbh, width: 2 },
        { name: 'Forehand', color: C.fh, values: vfh, width: 2 }
      ],
      height: 260
    });

    Charts.bars($('#chart-netround'), {
      categories: ['Rd 1', 'Rd 2', 'Rd 3', 'Rd 4', 'Rd 5'],
      yMax: 12, yTicks: 4, valueLabels: true,
      fmtV: function (v) { return v.toFixed(1); },
      series: [
        { name: 'Backhand', color: C.bh, values: setAverages('bh') },
        { name: 'Forehand', color: C.fh, values: setAverages('fh') }
      ],
      height: 240
    });

    renderHeat();
  }

  function panel(id, title, sub, legendHtml) {
    return '<div class="panel"><h2>' + title + '</h2><p class="sub">' + sub + '</p>' +
      (legendHtml || '') + '<div id="chart-' + id + '"></div></div>';
  }

  function renderHeat() {
    var byDate = {};
    sessions.forEach(function (s) { byDate[s.date] = discsThrown(s); });
    var end = new Date(today() + 'T12:00:00');
    end.setDate(end.getDate() + (6 - end.getDay()));      // finish the current week
    var cells = [];
    for (var i = 18 * 7 - 1; i >= 0; i--) {
      var d = new Date(end.getTime() - i * 86400000);
      var iso = isoLocal(d);
      var n = byDate[iso] || 0;
      var lv = n === 0 ? 0 : n <= 100 ? 1 : n <= 220 ? 2 : 3;
      cells.push('<i data-lv="' + lv + '" title="' + longDate(iso) +
        (n ? ' · ' + n + ' discs' : ' · no session') + '"></i>');
    }
    $('#heat').innerHTML = cells.join('');
  }

  /* ------------------------------------------------------- sync status */
  function syncAgo(iso) {
    var min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return min + ' min ago';
    var hr = Math.round(min / 60);
    if (hr < 24) return hr + ' hr ago';
    return 'on ' + longDate(iso.slice(0, 10));
  }

  function renderSyncStatus(s) {
    var el = $('#syncStatus');
    if (!el) return;
    var n = s.pending, plural = n === 1 ? '' : 's';
    var text = '', warn = false;

    if (s.syncing) {
      text = 'Syncing…';
    } else if (!s.online) {
      text = n ? n + ' session' + plural + ' waiting to sync — offline' : 'Offline';
      warn = true;
    } else if (n && s.error) {
      text = n + ' session' + plural + ' waiting to sync — last attempt failed, retrying';
      warn = true;
    } else if (n) {
      text = n + ' session' + plural + ' waiting to sync';
    } else if (s.lastSyncAt) {
      text = 'Synced ' + syncAgo(s.lastSyncAt);
    }

    el.textContent = text;
    el.classList.toggle('warn', warn);
  }

  /* --------------------------------------------------------------- boot */
  $('#date').max = today();
  fillForm(null);
  renderHistory();
  renderAnalytics();

  /* Another device (or a restore) changed the data underneath us. */
  DGStore.onChange(function () {
    sessions = Store.read();
    sortSessions();
    renderHistory();
    renderAnalytics();
    refreshForm();
  });

  DGStore.onStatus(renderSyncStatus);
  renderSyncStatus(DGStore.status());

  DGStore.start();
})();
