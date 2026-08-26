'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const db = require('../server/db');
const auth = require('../server/auth');
const { ValidationError } = require('../server/shape');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'disc-auth-test-'));
const FILE = path.join(TMP, 'test.sqlite');

test.before(() => { db.open(FILE); });
test.after(() => { db.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('hashPassword/verifyPassword round-trip', () => {
  const hash = auth.hashPassword('correct horse battery staple');
  assert.equal(auth.verifyPassword('correct horse battery staple', hash), true);
});

test('verifyPassword rejects a wrong password', () => {
  const hash = auth.hashPassword('correct horse battery staple');
  assert.equal(auth.verifyPassword('wrong', hash), false);
});

test('verifyPassword rejects a malformed encoding instead of throwing', () => {
  assert.equal(auth.verifyPassword('anything', 'not-a-real-hash'), false);
});

test('createSession/getSession/destroySession round-trip', () => {
  const userId = db.handle().prepare(
    'INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)'
  ).run('sessiontest', auth.hashPassword('pw'), db.nowIso()).lastInsertRowid;

  const token = auth.createSession(userId);
  const session = auth.getSession(token);
  assert.equal(session.id, userId);
  assert.equal(session.username, 'sessiontest');
  assert.equal(session.displayName, 'sessiontest', 'no display name set falls back to the username');
  assert.equal(session.putterMax, 20);
  assert.equal(session.driverMax, 14);
  assert.equal(session.putterSets, 5);
  assert.equal(session.driverSets, 5);

  auth.destroySession(token);
  assert.equal(auth.getSession(token), null);
});

test('getSession returns the display name when one is set, not the username', () => {
  const userId = auth.createUser('withdisplay', 'a-fine-password', 'Fancy Name');
  const token = auth.createSession(userId);
  assert.equal(auth.getSession(token).displayName, 'Fancy Name');
});

test('getSession returns null for an unknown or missing token', () => {
  assert.equal(auth.getSession('not-a-real-token'), null);
  assert.equal(auth.getSession(null), null);
  assert.equal(auth.getSession(undefined), null);
});

test('tokenFromRequest parses the session cookie out of a raw Cookie header', () => {
  const req = { headers: { cookie: 'other=1; dg_session=abc123; another=2' } };
  assert.equal(auth.tokenFromRequest(req), 'abc123');
  assert.equal(auth.tokenFromRequest({ headers: {} }), null);
});

/* --------------------------------------------------------------- createUser */

test('createUser makes a login-able account with default maxes', () => {
  const id = auth.createUser('newperson', 'a-fine-password');
  const user = auth.findUserByUsername('newperson');
  assert.equal(user.id, id);
  assert.equal(auth.verifyPassword('a-fine-password', user.password_hash), true);
  assert.equal(user.putter_max, 20);
  assert.equal(user.driver_max, 14);
});

test('createUser refuses a username that is already taken', () => {
  auth.createUser('taken', 'a-fine-password');
  assert.throws(() => auth.createUser('taken', 'another-password'), ValidationError);
  // and the original account's password is untouched
  const user = auth.findUserByUsername('taken');
  assert.equal(auth.verifyPassword('a-fine-password', user.password_hash), true);
});

test('createUser refuses a short password', () => {
  assert.throws(() => auth.createUser('shortpw', 'short'), ValidationError);
  assert.equal(auth.findUserByUsername('shortpw'), undefined);
});

test('createUser refuses an invalid username', () => {
  assert.throws(() => auth.createUser('', 'a-fine-password'), ValidationError);
  assert.throws(() => auth.createUser('has a space', 'a-fine-password'), ValidationError);
  assert.throws(() => auth.createUser(undefined, 'a-fine-password'), ValidationError);
});

/* ---------------------------------------------------------- updateUserSettings */

test('updateUserSettings changes only the fields given', () => {
  const userId = auth.createUser('settingstest', 'a-fine-password');
  const updated = auth.updateUserSettings(userId, { driverMax: 18 });
  assert.equal(updated.driver_max, 18);
  assert.equal(updated.putter_max, 20, 'putterMax was not in the patch, must be unchanged');
  assert.equal(updated.putter_sets, 5);
  assert.equal(updated.driver_sets, 5);
});

test('updateUserSettings can change all four fields at once', () => {
  const userId = auth.createUser('settingstest2', 'a-fine-password');
  const updated = auth.updateUserSettings(userId, { putterMax: 16, driverMax: 12, putterSets: 4, driverSets: 6 });
  assert.equal(updated.putter_max, 16);
  assert.equal(updated.driver_max, 12);
  assert.equal(updated.putter_sets, 4);
  assert.equal(updated.driver_sets, 6);
});

test('updateUserSettings refuses out-of-range values', () => {
  const userId = auth.createUser('settingstest3', 'a-fine-password');
  assert.throws(() => auth.updateUserSettings(userId, { putterMax: 0 }), ValidationError);
  assert.throws(() => auth.updateUserSettings(userId, { putterMax: 201 }), ValidationError);
  assert.throws(() => auth.updateUserSettings(userId, { putterSets: 0 }), ValidationError);
  assert.throws(() => auth.updateUserSettings(userId, { putterSets: 51 }), ValidationError);
  assert.throws(() => auth.updateUserSettings(userId, { driverMax: 1.5 }), ValidationError);
  assert.throws(() => auth.updateUserSettings(userId, { driverMax: 'lots' }), ValidationError);
});

test('updateUserSettings refuses an empty patch', () => {
  const userId = auth.createUser('settingstest4', 'a-fine-password');
  assert.throws(() => auth.updateUserSettings(userId, {}), ValidationError);
});

test('updateUserSettings never touches an existing session\'s own locked-in snapshot', () => {
  const { parseSession } = require('../server/shape');
  const { limitsForUser, snapshotForUser } = require('../server/config');

  const userId = auth.createUser('settingstest5', 'a-fine-password');
  const user = { putterMax: 20, driverMax: 14, putterSets: 5, driverSets: 5 };
  const s = parseSession({
    date: '2026-08-05', p15: [1, null, null, null, null],
    p25: [], bh: [], fh: [], notes: ''
  }, null, limitsForUser(user));
  db.upsertSession(userId, s, { snapshot: snapshotForUser(user) });

  auth.updateUserSettings(userId, { putterMax: 30 });

  const stored = db.getSession(userId, '2026-08-05');
  assert.equal(stored.putterMax, 20, 'changing the account default must not rewrite an existing session');
});
