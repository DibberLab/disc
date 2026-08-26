'use strict';

const path = require('path');
const express = require('express');

const db = require('./db');
const api = require('./routes/sessions');
const { ValidationError } = require('./shape');

const PORT = Number(process.env.PORT || 8080);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'disc.sqlite');
const WRITE_TOKEN = process.env.DG_WRITE_TOKEN || '';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

db.open(DB_FILE);
console.log(`[app] database at ${DB_FILE}`);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);            // nginx sits in front; needed for real client IPs
app.use(express.json({ limit: '512kb' }));

/* --- write protection -----------------------------------------------------
   Off unless DG_WRITE_TOKEN is set. disc.dibberlab.me is a public URL with no
   login, so until this is switched on anyone who finds it can overwrite or
   wipe the log. The nightly backup in scripts/backup.sh is the safety net;
   setting the token is the actual fix. See docs/DEPLOY.md.                  */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

app.use('/api', (req, res, next) => {
  if (!WRITE_TOKEN || !MUTATING.has(req.method)) return next();
  if (req.get('X-DG-Token') === WRITE_TOKEN) return next();
  res.status(401).json({ error: 'write token required' });
});

/* --- crude write rate limit -----------------------------------------------
   One process, one user, no Redis. Enough to stop a scraper hammering the
   write path; not a security control.                                       */
const hits = new Map();
const WINDOW_MS = 60_000;
const MAX_WRITES = 120;

app.use('/api', (req, res, next) => {
  if (!MUTATING.has(req.method)) return next();
  const now = Date.now();
  const key = req.ip || 'unknown';
  const list = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= MAX_WRITES) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'too many writes, slow down' });
  }
  list.push(now);
  hits.set(key, list);
  if (hits.size > 500) hits.clear();          // bounded; worst case one free window
  next();
});

app.use('/api', api);

app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  setHeaders(res, filePath) {
    /* index.html must never be cached or a deploy leaves phones on old JS.
       The rest is fine to cache briefly. */
    if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=300');
  }
}));

app.use((req, res) => res.status(404).json({ error: 'not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'malformed JSON' });
  console.error('[app] unhandled', err);
  res.status(500).json({ error: 'server error' });
});

const server = app.listen(PORT, () => console.log(`[app] listening on ${PORT}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[app] ${sig}, closing`);
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 8000).unref();
  });
}
