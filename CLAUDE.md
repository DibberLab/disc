# disc — a shared disc golf training log

Training tracker, now multi-user: putters at 15 ft and 25 ft (five sets each),
plus mids and drivers at the net backhand and forehand (five rounds each). How
many discs are in a set is a per-user setting (`users.putter_max`/
`driver_max`, defaults 20 putters / 14 drivers), not a fixed constant — see
"Decisions already made" below. Runs at **disc.dibberlab.me** on the dibberlab
droplet.

It started as a single-file browser app storing everything in `localStorage`.
This repo is that app with a real database behind it, and an offline layer so it
still works standing at a basket with no signal.

**Read `docs/API.md` before touching sync, and `docs/REVIEW.md` before "cleaning
up" anything in `public/app.js`.** Several things in there look wrong and are
deliberate.

## Layout

```
server/
  index.js            express wiring, static serving, auth gate, rate limit
  auth.js              password hashing (scrypt), session cookie CRUD
  db.js               SQLite: migrations, reads, writes, the sync merge
  shape.js            validation + DB rows <-> wire shape
  config.js           station set-counts + STATION_CATEGORY (putter/driver) + maxesForUser()
  routes/sessions.js  the REST surface, scoped by req.user
  routes/auth.js       /login /logout /me
  migrations/         NNN_*.sql, applied on boot, recorded in schema_migrations
public/
  index.html  styles.css  charts.js   carried over, index.html gained a login screen
  app.js                              storage seam swapped, gated behind DGAuth.boot()
  auth.js                              NEW: login gate, talks to /api/login /logout /me
  store.js                            NEW: localStorage cache + outbox + sync, per-user namespaced
  print-sheet.html                    printable version, maxes read from ?p=&d= query params
scripts/create-user.js  create/reset a login account (also the only way to add one)
test/                db.test.js, auth.test.js: schema, ownership, sync; store.test.js: client cache
deploy/               nginx site config
scripts/backup.sh     nightly SQLite backup
legacy/               the original single-file app, tarball, and spreadsheet
docs/                 REVIEW.md, API.md, DEPLOY.md
```

## How it works

`localStorage` is still what the UI reads and writes, so nothing about logging a
session got slower or needs a network. `public/store.js` sits under `app.js`,
diffs every write against the previous state, queues the changes in an outbox,
and pushes them to `POST /api/sync` when there is a connection. Conflicts resolve
last-write-wins with tombstones for deletes; the rules are stated once in
`docs/API.md` and implemented on both sides.

`app.js`'s `Store` object delegates to `DGStore`, and `DGStore.onChange`/
`onRosterChange` re-render hooks keep History and Analytics in sync with both
the local outbox and the server. The whole thing is held behind a login gate:
`public/auth.js` calls `DGAuth.boot(fn)`, which resolves a session (or shows
`#loginScreen`) before `fn` — `app.js`'s `boot(me)` — ever runs, so nothing in
`app.js` executes for a logged-out visitor. `sessions` in `app.js` is always
*my own* writable sessions; `allSessions` is a separate, read-only merge of
everyone's (mine, live, plus `DGStore.readRoster()` for everyone else) used
only by History and Analytics — never fed back through `Store.write()`. The
form, the charts, the core analytics math are otherwise the original code,
just re-parametrized on per-session `putterMax`/`driverMax` instead of a
literal 20/12.

## Decisions already made, do not relitigate

- **Multi-user, real login.** Andy's call, superseding the original "single
  user, no login." Username + password, server-side session cookie
  (`web_sessions` table, `scrypt` hashing — no bcrypt, no second native
  dependency alongside `better-sqlite3`). `DG_WRITE_TOKEN` is gone, not kept
  alongside real auth. No signup form — accounts are created with
  `scripts/create-user.js`.
- **Full visibility, scoped writes.** Every logged-in user sees every
  account's sessions (History, and Analytics via its user switcher). Nobody
  can create, edit, or delete a session that isn't their own — ownership is
  always taken from the session cookie server-side, never from the request
  body. Reads require login too — there's no anonymous view of the data.
- **Putter/driver counts are per-user data, not a constant.** `users
  .putter_max`/`driver_max`, defaults 20 / 14, changed by editing that user's
  row (no settings UI yet — see Build order). `sets: 5` per station is still
  a fixed constant, shared between `config.js` and `GRIDS[key].count` in
  `app.js`.
- **SQLite, not Postgres.** A handful of users, a few thousand rows a decade.
  A file on a volume with a nightly backup is the right size of thing.
- **`better-sqlite3`, not `node:sqlite`.** The built-in is still flagged
  experimental and its API can move under a Node upgrade; this thing should keep
  running untouched for years. It is a native module, hence the multi-stage
  Dockerfile. `db.js` is the only file that imports it.
- **One session per user per calendar date**, enforced by `UNIQUE(user_id,
  date)`. Two different users can each have their own session on the same
  date. Changing the per-user part later is a migration, not a setting.
- **A skipped set has no row; a set thrown with nothing made is `made = 0`.**
  Never collapse these into one thing.

## Build order

1. **Fix the three bugs in `docs/REVIEW.md` §1–3.** The timezone one is real —
   sample data lands a day late after 6pm Central. Do this first, it touches
   `app.js` and everything else builds on it.
2. **Show sync state in the UI.** `DGStore.onStatus(fn)` already fires with
   `{online, syncing, pending, lastSyncAt, error, storageBroken}` and there is an
   empty `#syncStatus` span in the footer waiting for it. "3 sessions waiting to
   sync" beats silence when the phone is offline. There is a `TODO(claude-code)`
   at the call site.
3. **Point the History tab's import/export at the server.** `GET
   /api/export.json` exists. `GET /api/export.csv` and `POST /api/import` are
   stubbed with TODOs in `routes/sessions.js` — lift the CSV column list from
   `#exportCsv` in `app.js`, it has to match the spreadsheet's Session Log tab.
4. **Test `store.js`.** `test/db.test.js` covers the server merge thoroughly;
   the client half has no tests. The outbox collapse, the legacy `v1` migration,
   and `applyRemote` are the parts worth pinning down.
5. **Deploy** — `docs/DEPLOY.md`, start to finish. Check the port is free first.
6. **Optional:** a service worker, so "Add to Home Screen" launches with no
   signal instead of needing one online load first.

## Guardrails

- **Set counts must agree** between `GRIDS[key].count` in `public/app.js` and
  `STATIONS[key].sets` in `server/config.js`. Change the number of sets in
  both or the client and server disagree about array length. The **max**
  (discs per set) is no longer a copy anywhere — it's per-user data
  (`users.putter_max`/`driver_max`), resolved through `config.maxesForUser()`
  and enforced in `shape.js`. `session_sets`' `CHECK` constraint only enforces
  a generous sanity bound (`0`–`200`) now, not the real cap — SQL can't
  reference the `users` table.
- **Never edit `001_init.sql` once it has run on the droplet.** Add `002_*.sql`.
- **Never change the port mapping in `docker-compose.yml` to a bare
  `8412:8080`.** The `127.0.0.1:` prefix is what keeps the app behind nginx and
  TLS instead of on the droplet's public IP.
- **nginx: `nginx -t` → reload → commit → push, every time.** `/etc/nginx` is a
  git checkout and a bad config takes down all ~30 sites on the box, not just
  this one.
- **`legacy/` is reference only.** Do not wire it back up or try to keep the
  single-file build in sync by hand — that hand-syncing is exactly what this
  restructure removed.
- **Run `npm test` before deploying.** The sync tests are cheap and they already
  caught one real bug (same-millisecond writes being dropped from `?since=`
  pulls).

## Commands

```bash
npm install
npm test                            # node --test, ~44 tests across test/*.test.js
npm run dev                         # node --watch, port 8080
docker compose up --build           # localhost:8412
node scripts/create-user.js andy    # create or reset a login account
```
