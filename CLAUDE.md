# disc — a shared disc golf training log

Training tracker, multi-user: putters at 15 ft and 25 ft, plus mids and
drivers at the net backhand and forehand. Both how many discs are in a set
(`putterMax`/`driverMax`) and how many sets get thrown (`putterSets`/
`driverSets`, defaults 20/14 discs, 5/5 sets) are adjustable per-account
settings — editable from the app's Settings panel, not fixed constants. Each
SESSION locks in the numbers that were true when it was first logged, though,
so changing your settings later never rewrites a past day's percentages —
see "Decisions already made" below. Runs at **disc.dibberlab.me** on the
dibberlab droplet.

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
  config.js           STATION_CATEGORY (putter/driver) + limitsForUser/limitsFromSnapshot/snapshotForUser
  routes/sessions.js  the REST surface, scoped by req.user, per-session snapshot resolution
  routes/auth.js       /login /logout /me (GET+PATCH) /register
  migrations/         NNN_*.sql, applied on boot, recorded in schema_migrations
public/
  index.html  styles.css  charts.js   carried over, index.html gained a login screen + settings panel
  app.js                              storage seam swapped, gated behind DGAuth.boot(), dynamic grid limits
  auth.js                              NEW: login gate + settings/add-account panels, talks to the auth API
  store.js                            NEW: localStorage cache + outbox + sync, per-user namespaced
  print-sheet.html                    printable version, maxes/sets read from ?p=&d=&ps=&ds= query params
scripts/create-user.js  create/reset-password/rename/set-display-name for an account
test/                db.test.js, auth.test.js, auth-client.test.js: schema, ownership, sync,
                      login-form + settings-panel wiring; store.test.js: client cache
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
just re-parametrized on per-session `putterMax`/`driverMax`/`putterSets`/
`driverSets` instead of a literal 20/12/5. `app.js`'s `GRIDS` is no longer a
boot-time constant either — `setFormLimits()` rebuilds it (and the Log tab's
actual input grid) to match whichever session is being edited, since an old
session's own locked-in numbers can differ from the account's current
settings. See the guardrail below before touching any of that.

## Decisions already made, do not relitigate

- **Multi-user, real login.** Andy's call, superseding the original "single
  user, no login." Username + password, server-side session cookie
  (`web_sessions` table, `scrypt` hashing — no bcrypt, no second native
  dependency alongside `better-sqlite3`). `DG_WRITE_TOKEN` is gone, not kept
  alongside real auth. **No public signup** — `POST /api/register` exists
  (the in-app "Add account" button) but is gated exactly like every other
  route, so only an already-logged-in user can create another account.
  `scripts/create-user.js` is still the only way to create the very first
  account, and the only way to reset a password or rename an existing
  account (`--rename-to`, `--display-name`).
- **`username` (stable identity) and `displayName` (cosmetic, shown in the
  UI) are separate** — `003_display_name.sql`. Falls back to `username` when
  unset. Nothing keys off `displayName`; renaming someone's display name
  never touches ownership, sessions, or login.
- **Full visibility, scoped writes.** Every logged-in user sees every
  account's sessions (History, and Analytics via its user switcher). Nobody
  can create, edit, or delete a session that isn't their own — ownership is
  always taken from the session cookie server-side, never from the request
  body. Reads require login too — there's no anonymous view of the data.
- **Putter/driver max AND set count are per-user settings, editable from the
  app** (the Settings panel, `PATCH /api/me`) — defaults 20/14 discs, 5/5
  sets. **Each session locks in the numbers that were true when it was first
  created** (`sessions.putter_max`/`driver_max`/`putter_sets`/`driver_sets`,
  a snapshot — see `004_per_session_limits.sql`), and editing that session
  later validates against and preserves ITS OWN snapshot, never the account's
  current settings. This was a deliberate call (asked directly, not
  assumed): a day you only had 16 drivers must stay `/16` forever, even after
  you change your default to 20. `server/routes/sessions.js`'s
  `resolveLimitsAndSnapshot()` is the one place that decides "new session,
  snapshot current settings" vs. "existing session, use its own" — every
  write path (`PUT`, `/sync`, `/import`) goes through it.
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

- **`public/auth.js` wires the login form itself, on load — it does not wait
  on `public/app.js`.** It used to: the login form only got a submit handler
  from inside app.js's own boot(), so a single uncaught error anywhere in
  app.js (a much bigger file, touching lots of DOM) left the login form
  silently dead — a bare submit just reloaded the page, no error, nothing to
  inspect. Reported as "no error messages, can't get past login, can't even
  inspect the page" (a mobile browser with no devtools). `DGAuth.boot(fn)` is
  now just "run fn once authenticated," decoupled from whether the login
  screen itself works. Don't reintroduce that coupling.
- **Neither set count nor max is a fixed copy anywhere any more** — both are
  per-session data (see the settings/snapshot bullet above), resolved through
  `config.limitsForUser()`/`limitsFromSnapshot()` and enforced in `shape.js`.
  `public/app.js`'s `GRIDS` is a runtime mirror of whichever session is
  currently being edited, rebuilt by `setFormLimits()` — it is never a
  build-time constant to keep in sync with the server. `STATIONS` in
  `server/config.js` is only the last-resort fallback for a caller with no
  user/session context (an unauthenticated request, or a test). The `CHECK`
  constraints on `session_sets.set_index` and `.made` are generous sanity
  bounds (0–49, 0–200), not the real cap — SQL can't reference another row's
  data, so the real cap only ever lives in `shape.js`.
- **`disc.dibberlab.me` is proxied through Cloudflare**, which overrides
  `public/`'s origin `Cache-Control: public, max-age=300` with its own
  4-hour edge cache for static files (`index.html` is `no-cache` and stays
  `DYNAMIC` at the edge — this only bites `styles.css`/`*.js`). A deploy that
  changes anything in `public/` and doesn't bump its `?v=N` query string in
  `index.html` can sit invisible behind Cloudflare's cache for up to 4 hours.
  Bump every `?v=` in `index.html` on any `public/` deploy — cheaper than
  reasoning about whether a given edge node still has the old file.
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
npm test                            # node --test, ~75 tests across test/*.test.js
npm run dev                         # node --watch, port 8080
docker compose up --build           # localhost:8412
node scripts/create-user.js andy    # create or reset a login account
```
