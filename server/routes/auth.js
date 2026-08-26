'use strict';

const express = require('express');
const auth = require('../auth');

const router = express.Router();

const COOKIE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

function cookieOpts() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: COOKIE_MAX_AGE_MS
  };
}

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'username and password are required' });
  }
  const user = auth.findUserByUsername(username);
  /* Always run verifyPassword, even on an unknown username, against a
     placeholder hash — otherwise a wrong-username request returns faster
     than a wrong-password one, which leaks which usernames exist via
     response timing. */
  const ok = user
    ? auth.verifyPassword(password, user.password_hash)
    : auth.verifyPassword(password, 'scrypt:16384:8:1:00:00');
  if (!user || !ok) return res.status(401).json({ error: 'invalid username or password' });

  const token = auth.createSession(user.id);
  res.cookie(auth.COOKIE_NAME, token, cookieOpts());
  res.json({ username: user.username, putterMax: user.putter_max, driverMax: user.driver_max });
});

router.post('/logout', (req, res) => {
  const token = auth.tokenFromRequest(req);
  if (token) auth.destroySession(token);
  res.clearCookie(auth.COOKIE_NAME);
  res.status(204).end();
});

/* req.user is guaranteed here — index.js's auth gate already 401'd anything
   without a valid session before requests reach this router. */
router.get('/me', (req, res) => {
  res.json({ username: req.user.username, putterMax: req.user.putterMax, driverMax: req.user.driverMax });
});

module.exports = router;
