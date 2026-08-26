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
