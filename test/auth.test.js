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
  assert.equal(session.putterMax, 20);
  assert.equal(session.driverMax, 14);

  auth.destroySession(token);
  assert.equal(auth.getSession(token), null);
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
