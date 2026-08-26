/* auth.js — login gate.
 *
 * The whole app sits behind a login now: this runs before app.js and holds
 * it back (via the onReady callback) until a session cookie is confirmed.
 * #loginScreen and #appRoot are both in index.html already; this just
 * toggles which one is visible and talks to /api/login, /api/logout, /api/me.
 *
 * Load order: store.js, auth.js, then app.js.
 */
(function (global) {
  'use strict';

  var me = null;

  function $(sel) { return document.querySelector(sel); }

  function showApp() {
    $('#loginScreen').hidden = true;
    $('#appRoot').hidden = false;
  }

  function showLogin(errorText) {
    $('#appRoot').hidden = true;
    $('#loginScreen').hidden = false;
    var err = $('#loginError');
    if (errorText) { err.textContent = errorText; err.hidden = false; } else { err.hidden = true; }
  }

  function applyMe(m) {
    me = m;
    $('#whoAmI').textContent = m.username;
  }

  function wireChrome() {
    $('#logoutBtn').addEventListener('click', function () {
      fetch('/api/logout', { method: 'POST' }).then(function () { global.location.reload(); });
    });
    wireAddAccount();
  }

  /* Only reachable once logged in — the button/panel live inside #appRoot,
     and POST /api/register itself is gated server-side (index.js's auth
     middleware doesn't put it in OPEN_PATHS), so this is never a public
     signup form, just a faster path than shelling in to run
     scripts/create-user.js. */
  function wireAddAccount() {
    var btn = $('#addAccountBtn');
    var form = $('#addAccountForm');
    var note = $('#addAccountNote');

    btn.addEventListener('click', function () {
      form.hidden = !form.hidden;
      note.textContent = '';
      if (!form.hidden) $('#newUsername').focus();
    });

    $('#cancelAddAccount').addEventListener('click', function () {
      form.hidden = true;
      form.reset();
      note.textContent = '';
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var username = $('#newUsername').value.trim();
      var password = $('#newPassword').value;
      note.textContent = 'Creating…';
      note.className = 'savenote';
      fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
      }).then(function (res) {
        return res.json().then(function (body) { return { ok: res.ok, body: body }; });
      }).then(function (r) {
        if (!r.ok) {
          note.textContent = r.body.error || 'Could not create that account.';
          note.className = 'savenote bad';
          return;
        }
        note.textContent = '';
        form.reset();
        form.hidden = true;
        alert('Account "' + r.body.username + '" created. Hand them the temporary password to log in with — they can change it later via scripts/create-user.js.');
      }).catch(function () {
        note.textContent = "Couldn't reach the server. Check the connection and try again.";
        note.className = 'savenote bad';
      });
    });
  }

  function wireLoginForm(onReady) {
    $('#loginForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var username = $('#loginUsername').value.trim();
      var password = $('#loginPassword').value;
      fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
      }).then(function (res) {
        return res.json().then(function (body) { return { ok: res.ok, body: body }; });
      }).then(function (r) {
        if (!r.ok) { showLogin(r.body.error || 'Login failed.'); return; }
        applyMe(r.body);
        showApp();
        wireChrome();
        onReady(me);
      }).catch(function () {
        showLogin("Couldn't reach the server. Check the connection and try again.");
      });
    });
  }

  function boot(onReady) {
    fetch('/api/me').then(function (res) {
      if (res.status === 401) { wireLoginForm(onReady); showLogin(); return; }
      return res.json().then(function (body) {
        applyMe(body);
        showApp();
        wireChrome();
        onReady(me);
      });
    }).catch(function () {
      wireLoginForm(onReady);
      showLogin("Couldn't reach the server. Check the connection and try again.");
    });
  }

  global.DGAuth = { boot: boot, me: function () { return me; } };
})(window);
