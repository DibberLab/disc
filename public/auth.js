/* auth.js — login gate.
 *
 * The whole app sits behind a login now. #loginScreen and #appRoot are both
 * in index.html; this toggles which one is visible and talks to
 * /api/login, /api/logout, /api/me, /api/register.
 *
 * Deliberately self-contained: everything the login screen needs (wiring
 * the form, checking /api/me) runs the moment THIS script executes, not
 * gated behind app.js calling back into it. Earlier this was backwards —
 * the login form only got wired up from inside app.js's own boot(), so a
 * single uncaught error anywhere in app.js (which does a lot more DOM work)
 * meant the login form silently had no handler at all: a bare submit just
 * reloaded the page with nothing visible, no error, nothing to inspect.
 * DGAuth.boot(fn) now just registers "run fn once authenticated" — it does
 * not gate whether the login screen itself works.
 *
 * Load order: store.js, auth.js, then app.js (app.js only needs to exist
 * for DGAuth.boot to have something to call later).
 */
(function (global) {
  'use strict';

  var me = null;
  var authenticated = false;
  var readyCallback = null;

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
    authenticated = true;
    $('#whoAmI').textContent = m.displayName || m.username;
    showApp();
    wireChrome();
    if (readyCallback) readyCallback(me);
  }

  var chromeWired = false;
  function wireChrome() {
    if (chromeWired) return;
    chromeWired = true;
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
      var displayName = $('#newDisplayName').value.trim();
      var password = $('#newPassword').value;
      note.textContent = 'Creating…';
      note.className = 'savenote';
      fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password, displayName: displayName || undefined })
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

  /* Wired immediately and unconditionally — see the file-level comment.
     Guarded so a second call (there isn't one today, but defensively) can't
     double-bind the submit handler. */
  var loginFormWired = false;
  function wireLoginForm() {
    if (loginFormWired) return;
    loginFormWired = true;
    $('#loginForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = $('#loginForm button[type="submit"]');
      var username = $('#loginUsername').value.trim();
      var password = $('#loginPassword').value;
      if (btn) btn.disabled = true;
      fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
      }).then(function (res) {
        return res.json().then(function (body) { return { ok: res.ok, body: body }; });
      }).then(function (r) {
        if (!r.ok) { showLogin(r.body.error || 'Login failed.'); return; }
        applyMe(r.body);
      }).catch(function (err) {
        showLogin("Couldn't reach the server (" + (err.message || err) + "). Check the connection and try again.");
      }).then(function () {
        if (btn) btn.disabled = false;
      });
    });
  }

  function init() {
    wireLoginForm();   // works regardless of what /api/me or app.js do below
    fetch('/api/me').then(function (res) {
      if (res.status === 401) { showLogin(); return; }
      if (!res.ok) { showLogin('Unexpected server response (' + res.status + '). Try reloading.'); return; }
      return res.json().then(applyMe);
    }).catch(function (err) {
      showLogin("Couldn't reach the server (" + (err.message || err) + "). Check the connection and try again.");
    });
  }

  /* Registers the callback app.js wants run once a session is confirmed.
     If we're already authenticated by the time this is called, run it
     right away — covers both orderings (app.js finishing before or after
     the /api/me check above resolves). */
  function boot(onReady) {
    readyCallback = onReady;
    if (authenticated) onReady(me);
  }

  /* Last-resort visibility net: if something throws that none of the
     try/catch-free promise chains above catch (a bug in app.js, say — those
     run independently of this file and are not wrapped here), at least put
     something on screen instead of a silent dead page. Only while the login
     screen is still showing; once the app is up this would just be noise
     from e.g. a browser extension. */
  global.addEventListener('error', function (e) {
    if ($('#loginScreen') && !$('#loginScreen').hidden) {
      showLogin('Something went wrong loading the app: ' + (e.message || 'unknown error') + '. Try reloading.');
    }
  });

  global.DGAuth = { boot: boot, me: function () { return me; } };
  init();
})(window);
