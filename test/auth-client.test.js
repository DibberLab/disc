'use strict';

/* public/auth.js is a browser script, same situation as public/store.js —
   see the comment at the top of test/store.test.js for why this loads the
   source into a `vm` sandbox with a hand-rolled DOM instead of pulling in
   jsdom for one file. The element map below covers exactly the selectors
   auth.js queries (grep '$('  in the source to confirm the list is
   complete if auth.js grows new ones).

   This exists because of a real bug: the login form used to only get wired
   up from inside app.js's own boot(), so any uncaught error in app.js (a
   much bigger file) left the login form with literally no submit handler —
   a bare native form submit just reloaded the page with nothing visible,
   which is exactly what got reported as "no error messages, nothing
   happens, can't inspect the page" (almost certainly a mobile browser with
   no devtools). auth.js now wires the login form immediately and
   independently of app.js; these tests pin that down. */

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.join(__dirname, '../public/auth.js'), 'utf8');

function makeEl(overrides) {
  const listeners = {};
  return Object.assign({
    hidden: false,
    textContent: '',
    className: '',
    value: '',
    disabled: false,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    trigger(type, evt) {
      (listeners[type] || []).forEach((fn) => fn(evt || { preventDefault() {} }));
    },
    focus() {},
    reset() { this.value = ''; }
  }, overrides);
}

function freshAuth({ fetchImpl } = {}) {
  const el = {
    loginScreen: makeEl(),
    appRoot: makeEl({ hidden: true }),
    loginError: makeEl({ hidden: true }),
    loginForm: makeEl(),
    loginSubmitBtn: makeEl(),
    loginUsername: makeEl(),
    loginPassword: makeEl(),
    whoAmI: makeEl(),
    logoutBtn: makeEl(),
    addAccountBtn: makeEl(),
    addAccountForm: makeEl({ hidden: true }),
    addAccountNote: makeEl(),
    cancelAddAccount: makeEl(),
    newUsername: makeEl(),
    newDisplayName: makeEl(),
    newPassword: makeEl(),
    settingsBtn: makeEl(),
    settingsForm: makeEl({ hidden: true }),
    settingsNote: makeEl(),
    cancelSettings: makeEl(),
    setPutterMax: makeEl(),
    setPutterSets: makeEl(),
    setDriverMax: makeEl(),
    setDriverSets: makeEl()
  };
  const selectorMap = {
    '#loginScreen': el.loginScreen,
    '#appRoot': el.appRoot,
    '#loginError': el.loginError,
    '#loginForm': el.loginForm,
    '#loginForm button[type="submit"]': el.loginSubmitBtn,
    '#loginUsername': el.loginUsername,
    '#loginPassword': el.loginPassword,
    '#whoAmI': el.whoAmI,
    '#logoutBtn': el.logoutBtn,
    '#addAccountBtn': el.addAccountBtn,
    '#addAccountForm': el.addAccountForm,
    '#addAccountNote': el.addAccountNote,
    '#cancelAddAccount': el.cancelAddAccount,
    '#newUsername': el.newUsername,
    '#newDisplayName': el.newDisplayName,
    '#newPassword': el.newPassword,
    '#settingsBtn': el.settingsBtn,
    '#settingsForm': el.settingsForm,
    '#settingsNote': el.settingsNote,
    '#cancelSettings': el.cancelSettings,
    '#setPutterMax': el.setPutterMax,
    '#setPutterSets': el.setPutterSets,
    '#setDriverMax': el.setDriverMax,
    '#setDriverSets': el.setDriverSets
  };

  // Real form.reset() clears its descendant fields too — the stub form
  // element isn't structurally connected to the field stubs, so wire that
  // up by hand for the one form tests actually call .reset() on.
  el.addAccountForm.reset = function () {
    el.newUsername.value = '';
    el.newDisplayName.value = '';
    el.newPassword.value = '';
  };

  const alerts = [];
  const location = { reloaded: false, reload() { this.reloaded = true; } };
  const sandbox = {
    document: {
      querySelector(sel) {
        if (!(sel in selectorMap)) throw new Error('unstubbed selector: ' + sel);
        return selectorMap[sel];
      }
    },
    fetch: fetchImpl || (() => Promise.reject(new Error('fetch not configured for this test'))),
    addEventListener() {},   // window.addEventListener('error', ...)
    location: location,
    alert(msg) { alerts.push(msg); },
    console
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'auth.js' });
  return { DGAuth: sandbox.DGAuth, el: el, alerts: alerts, location: location };
}

function okJson(body, status) {
  return () => Promise.resolve({
    ok: (status || 200) < 300,
    status: status || 200,
    json: () => Promise.resolve(body)
  });
}

/* --------------------------------------------------- login form wiring */

test('the login form gets a submit handler immediately on load, with no /api/me response yet', () => {
  let resolveMe;
  const mePending = new Promise((r) => { resolveMe = r; });
  const { el } = freshAuth({ fetchImpl: () => mePending });

  // Before the pending /api/me ever resolves, the form must already work.
  assert.doesNotThrow(() => el.loginForm.trigger('submit'));
  resolveMe({ ok: false, status: 401, json: () => Promise.resolve({}) });
});

test('a 401 from /api/me shows the login screen with no error text', async () => {
  const { el } = freshAuth({ fetchImpl: okJson({}, 401) });
  await new Promise((r) => setImmediate(r));
  assert.equal(el.loginScreen.hidden, false);
  assert.equal(el.appRoot.hidden, true);
  assert.equal(el.loginError.hidden, true);
});

test('submitting valid credentials logs in: cookie flow succeeds, app shown, onReady fires', async () => {
  const calls = [];
  const fetchImpl = (url, opts) => {
    calls.push(url);
    if (url === '/api/me') return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
    if (url === '/api/login') {
      const body = JSON.parse(opts.body);
      assert.equal(body.username, 'andy');
      assert.equal(body.password, 'hunter2');
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ username: 'andy', putterMax: 20, driverMax: 14 })
      });
    }
    throw new Error('unexpected fetch: ' + url);
  };
  const { DGAuth, el } = freshAuth({ fetchImpl });
  await new Promise((r) => setImmediate(r));   // let the /api/me check settle

  let readyMe = null;
  DGAuth.boot((me) => { readyMe = me; });

  el.loginUsername.value = 'andy';
  el.loginPassword.value = 'hunter2';
  el.loginForm.trigger('submit');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(el.appRoot.hidden, false);
  assert.equal(el.loginScreen.hidden, true);
  assert.equal(el.whoAmI.textContent, 'andy');
  assert.ok(readyMe && readyMe.username === 'andy', 'DGAuth.boot callback must fire after a successful login');
  assert.ok(calls.includes('/api/login'));
});

test('wrong credentials show a visible error and never touch #appRoot', async () => {
  const fetchImpl = (url) => {
    if (url === '/api/me') return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
    if (url === '/api/login') {
      return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ error: 'invalid username or password' }) });
    }
    throw new Error('unexpected fetch: ' + url);
  };
  const { el } = freshAuth({ fetchImpl });
  await new Promise((r) => setImmediate(r));

  el.loginUsername.value = 'andy';
  el.loginPassword.value = 'wrong';
  el.loginForm.trigger('submit');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(el.loginError.hidden, false);
  assert.equal(el.loginError.textContent, 'invalid username or password');
  assert.equal(el.appRoot.hidden, true, 'a failed login must never reveal the app');
});

test('a network error on submit shows a visible message instead of failing silently', async () => {
  const fetchImpl = (url) => {
    if (url === '/api/me') return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
    if (url === '/api/login') return Promise.reject(new TypeError('Failed to fetch'));
    throw new Error('unexpected fetch: ' + url);
  };
  const { el } = freshAuth({ fetchImpl });
  await new Promise((r) => setImmediate(r));

  el.loginForm.trigger('submit');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(el.loginError.hidden, false);
  assert.match(el.loginError.textContent, /couldn.t reach the server/i);
});

test('an already-valid session on load skips straight to the app and fires boot() immediately', async () => {
  const fetchImpl = (url) => {
    if (url === '/api/me') {
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ username: 'andy', putterMax: 20, driverMax: 14 })
      });
    }
    throw new Error('unexpected fetch: ' + url);
  };
  const { DGAuth, el } = freshAuth({ fetchImpl });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(el.appRoot.hidden, false);

  // boot() registered AFTER the session was already confirmed must still fire.
  let readyMe = null;
  DGAuth.boot((me) => { readyMe = me; });
  assert.ok(readyMe && readyMe.username === 'andy');
});

test('DGAuth.me() reflects the logged-in user after a successful login', async () => {
  const fetchImpl = (url) => {
    if (url === '/api/me') return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
    if (url === '/api/login') {
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ username: 'riley', putterMax: 20, driverMax: 10 })
      });
    }
    throw new Error('unexpected fetch: ' + url);
  };
  const { DGAuth, el } = freshAuth({ fetchImpl });
  await new Promise((r) => setImmediate(r));

  el.loginForm.trigger('submit');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(DGAuth.me(), { username: 'riley', putterMax: 20, driverMax: 10 });
});

/* ------------------------------------------------------------ add account */

async function loggedIn(fetchExtra) {
  const fetchImpl = (url, opts) => {
    // Only the plain boot-time GET is auto-handled — a PATCH (or anything
    // else) to the same URL falls through to fetchExtra, so tests can mock
    // POST /api/register or PATCH /api/me without this swallowing them.
    if (url === '/api/me' && (!opts || !opts.method)) {
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ username: 'andy', displayName: 'Andy', putterMax: 20, driverMax: 14, putterSets: 5, driverSets: 5 })
      });
    }
    if (fetchExtra) { const r = fetchExtra(url, opts); if (r) return r; }
    throw new Error('unexpected fetch: ' + url);
  };
  const result = freshAuth({ fetchImpl });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return result;
}

test('the topbar shows the display name, not the raw username', async () => {
  const { el } = await loggedIn();
  assert.equal(el.whoAmI.textContent, 'Andy');
});

test('the "Add account" button toggles the panel and focuses the username field', async () => {
  const { el } = await loggedIn();
  assert.equal(el.addAccountForm.hidden, true);

  let focused = false;
  el.newUsername.focus = () => { focused = true; };
  el.addAccountBtn.trigger('click');
  assert.equal(el.addAccountForm.hidden, false);
  assert.equal(focused, true);

  el.addAccountBtn.trigger('click');
  assert.equal(el.addAccountForm.hidden, true);
});

test('cancel hides the panel and clears the fields', async () => {
  const { el } = await loggedIn();
  el.addAccountBtn.trigger('click');
  el.newUsername.value = 'riley';
  el.cancelAddAccount.trigger('click');
  assert.equal(el.addAccountForm.hidden, true);
  assert.equal(el.newUsername.value, '');
});

test('submitting the add-account form posts username/displayName/password and confirms on success', async () => {
  let registerBody = null;
  const { el, alerts } = await loggedIn((url, opts) => {
    if (url === '/api/register') {
      registerBody = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ username: 'riley' }) });
    }
  });

  el.newUsername.value = 'riley';
  el.newDisplayName.value = 'Riley';
  el.newPassword.value = 'a-fine-password';
  el.addAccountForm.trigger('submit');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(registerBody, { username: 'riley', password: 'a-fine-password', displayName: 'Riley' });
  assert.equal(el.addAccountForm.hidden, true, 'the panel closes on success');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /riley/);
});

test('a taken username shows the server error inline and leaves the panel open', async () => {
  const { el, alerts } = await loggedIn((url) => {
    if (url === '/api/register') {
      return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: 'that username is already taken' }) });
    }
  });

  el.addAccountBtn.trigger('click');
  el.newUsername.value = 'andy';
  el.newPassword.value = 'a-fine-password';
  el.addAccountForm.trigger('submit');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(el.addAccountNote.textContent, 'that username is already taken');
  assert.equal(el.addAccountForm.hidden, false, 'a failed create must not close the panel');
  assert.equal(alerts.length, 0);
});

/* --------------------------------------------------------------- settings */

test('opening Settings pre-fills the current putter/driver max and set counts', async () => {
  const { el } = await loggedIn();
  el.settingsBtn.trigger('click');
  assert.equal(el.settingsForm.hidden, false);
  assert.equal(el.setPutterMax.value, 20);
  assert.equal(el.setPutterSets.value, 5);
  assert.equal(el.setDriverMax.value, 14);
  assert.equal(el.setDriverSets.value, 5);
});

test('cancel closes the settings panel', async () => {
  const { el } = await loggedIn();
  el.settingsBtn.trigger('click');
  el.cancelSettings.trigger('click');
  assert.equal(el.settingsForm.hidden, true);
});

test('saving settings PATCHes /api/me with all four fields and reloads on success', async () => {
  let patchBody = null;
  const { el, location } = await loggedIn((url, opts) => {
    if (url === '/api/me' && opts && opts.method === 'PATCH') {
      patchBody = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    }
  });

  el.settingsBtn.trigger('click');
  el.setPutterMax.value = '24';
  el.setPutterSets.value = '6';
  el.setDriverMax.value = '16';
  el.setDriverSets.value = '4';
  el.settingsForm.trigger('submit');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(patchBody, { putterMax: 24, putterSets: 6, driverMax: 16, driverSets: 4 });
  assert.equal(location.reloaded, true, 'a successful save must reload so the new limits take effect');
});

test('a rejected settings save shows the error inline and does not reload', async () => {
  const { el, location } = await loggedIn((url, opts) => {
    if (url === '/api/me' && opts && opts.method === 'PATCH') {
      return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: 'putter max must be an integer between 1 and 200' }) });
    }
  });

  el.settingsBtn.trigger('click');
  el.settingsForm.trigger('submit');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(el.settingsNote.textContent, 'putter max must be an integer between 1 and 200');
  assert.equal(location.reloaded, false);
});
