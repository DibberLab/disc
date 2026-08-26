# disc — Andy's disc golf training log

Personal training tracker. Twenty putters at 15 ft and 25 ft, five sets of 20 at
each, plus twelve mids and drivers at the net backhand and forehand, five rounds
of 12. Runs at **disc.dibberlab.me** on the dibberlab droplet.

It started as a single-file browser app storing everything in `localStorage`.
This repo is that app with a real database behind it, and an offline layer so it
still works standing at a basket with no signal.

**Read `docs/API.md` before touching sync, and `docs/REVIEW.md` before "cleaning
up" anything in `public/app.js`.** Several things in there look wrong and are
deliberate.

## Layout

```
server/
  index.js            express wiring, static serving, write token, rate limit
  db.js               SQLite: migrations, reads, writes, the sync merge
  shape.js            validation + DB rows <-> wire shape
  config.js           station definitions (mirrored in 2 other places — see below)
  routes/sessions.js  the REST surface
  migrations/         NNN_*.sql, applied on boot, recorded in schema_migrations
public/
  index.html  styles.css  charts.js   carried over untouched
  app.js                              carried over, storage seam swapped
  store.js                            NEW: localStorage cache + outbox + sync
  print-sheet.html                    printable version, untouched
test/db.test.js       15 tests: schema, round-trip, cascade, every sync branch
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

`app.js` was changed in exactly three places: the `Store` object now delegates to
`DGStore`, there is a `DGStore.onChange` re-render hook at the bottom, and
`DGStore.start()` boots it. Everything else — the form, the charts, the
analytics — is the original code.

## Decisions already made, do not relitigate

- **Single user, no login.** Andy's call. `DG_WRITE_TOKEN` is wired up and off.
- **SQLite, not Postgres.** One user, a few thousand rows a decade. A file on a
  volume with a nightly backup is the right size of thing.
- **`better-sqlite3`, not `node:sqlite`.** The built-in is still flagged
  experimental and its API can move under a Node upgrade; this thing should keep
  running untouched for years. It is a native module, hence the multi-stage
  Dockerfile. `db.js` is the only file that imports it.
- **One session per calendar date**, enforced by `UNIQUE(date)`. Matches the old
  behaviour. Changing it later is a migration, not a setting.
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

- **Three copies of the station definitions** must agree: `GRIDS` in
  `public/app.js`, `STATIONS` in `server/config.js`, and the `CHECK` constraint
  in `001_init.sql`. Change a max or a set count in all three or the failure is
  a constraint violation on write, long after the edit.
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
npm test                     # node --test, 15 tests
npm run dev                  # node --watch, port 8080
docker compose up --build    # localhost:8412
```
