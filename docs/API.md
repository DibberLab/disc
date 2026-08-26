# API contract

Base path `/api`. JSON in, JSON out. Every route requires a logged-in session
(cookie `dg_session`) except `/api/health` (the Docker healthcheck has no
cookie) and `/api/login` (how you get one) — see **Auth** below. All
timestamps are ISO-8601 UTC with milliseconds — `2026-08-26T14:03:11.212Z` —
always that exact width, because the sync rules compare them as **strings**
and fixed width is what makes `<` chronological.

## Auth

Username + password, server-side session (table `web_sessions`, not a
signed/stateless cookie — the cookie is just a high-entropy lookup key, so
logout is a plain row delete). No public signup: `/api/register` exists but
is gated the same as everything else (not in `index.js`'s `OPEN_PATHS`), so
only an already-logged-in user can create another account — that's the "Add
account" button in the app. `scripts/create-user.js` is still how the very
first account gets created (and the only way to reset a password today).

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/login` | `{username, password}` → `200` + `Set-Cookie` + `{username, putterMax, driverMax}`, or `401`. |
| `POST` | `/api/logout` | Destroys the session, clears the cookie. `204`. |
| `GET` | `/api/me` | `{username, putterMax, driverMax}` for the caller, or `401`. |
| `POST` | `/api/register` | **Requires login.** `{username, password}` → `201` + `{username}`. New account gets default maxes (20/14). `400` on a taken username, an invalid one (2-32 chars, letters/numbers/`-`/`_`), or a password under 8 characters. |

## The session shape

Identical to what `public/app.js` has always held in memory, plus `updatedAt`.
On a read (`GET`/`sync`/`export`), it also carries who it belongs to:

```json
{
  "date": "2026-08-26",
  "p15": [18, 17, null, 16, 15],
  "p25": [11, 9, null, 10, 8],
  "bh":  [7, 8, 6, null, 7],
  "fh":  [5, 6, 4, null, 5],
  "notes": "headwind out of the north",
  "updatedAt": "2026-08-26T14:03:11.212Z",
  "userId": 1,
  "username": "andy",
  "putterMax": 20,
  "driverMax": 14
}
```

`userId`/`username`/`putterMax`/`driverMax` are read-only — set by the server
from who's logged in, and ignored if a client sends them on a write. `null`
means that set was not thrown. `0` means it was thrown and nothing went in.
These are different and the whole percentage model depends on the difference.
Arrays are always length 5.

Putting stations (`p15`, `p25`) take `0`–`putterMax`. Net stations (`bh`,
`fh`) take `0`–`driverMax` — per-user settings, not fixed constants (defaults
20 / 14, see `GET /api/me`). The server **rejects** out-of-range values rather
than clamping them — the client clamps at the input, so anything out of range
on the wire is a bug worth seeing.

## Endpoints

Reads are full-visibility: any logged-in user sees every account's sessions,
tagged with who they belong to. Writes are always scoped to the caller's own
account — there is no way to edit or delete someone else's session through
this API.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/health` | `{ok, serverTime, sessions, sets, deletions, lastUpdatedAt}`. Docker healthcheck hits this, no login required. |
| `GET` | `/api/sessions` | `{serverTime, sessions[]}`, oldest first, everyone's. |
| `GET` | `/api/sessions?since=ISO` | Only sessions with `updated_at > since`. |
| `GET` | `/api/sessions/:date` | The caller's own session on that date, or `404`. |
| `PUT` | `/api/sessions/:date` | Upsert into the caller's own date-slot. `201` created, `200` updated, `400` invalid. Path date wins over body date. |
| `DELETE` | `/api/sessions/:date` | The caller's own session. `204` if it existed, `404` if not. Writes a tombstone either way. |
| `POST` | `/api/sync` | The offline reconciliation endpoint, scoped to the caller. See below. |
| `GET` | `/api/export.json` | Everyone's sessions, same envelope the old "Back up as JSON" button produced. |
| `GET` | `/api/export.csv` | Everyone's sessions, one "User" column added. Column order otherwise matches the Session Log tab of the spreadsheet — mirrors `#exportCsv` in `public/app.js`. |
| `POST` | `/api/import` | `{sessions[], mode: "merge"｜"replace"}`, scoped to the caller's own account. Every session runs through `shape.parseSession`. |

`PUT` is the plain "Save session" path: a deliberate write from the UI always
wins and the server stamps `updatedAt`. Conflict resolution lives only in
`/sync`.

## POST /api/sync

The one interesting endpoint. Request:

```json
{
  "since": "2026-08-26T13:00:00.000Z",
  "sessions": [ /* full session objects, each with a client updatedAt */ ],
  "deletions": [ { "date": "2026-08-24", "deletedAt": "2026-08-26T13:40:02.881Z" } ]
}
```

Response:

```json
{
  "serverTime": "2026-08-26T14:03:11.212Z",
  "applied": { "upserted": ["2026-08-26"], "deleted": [], "skipped": [] },
  "sessions": [ /* everything changed since `since` */ ],
  "deletions": [ /* tombstones since `since` */ ]
}
```

The client stores `serverTime` as its next `since`.

### Merge rules

Last-write-wins on `updatedAt`, with deletes treated as writes:

1. **Incoming session vs a tombstone.** If a tombstone for that date has
   `deleted_at >= updatedAt`, skip it — `reason: "deleted-on-server"`. A delete
   on the laptop beats a stale copy sitting in the phone's outbox.
2. **Incoming session vs the stored one.** If `stored.updated_at >= updatedAt`,
   skip — `reason: "server-newer"`. Otherwise upsert, and clear the tombstone:
   **re-logging a deleted date undeletes it**, which is what you want when the
   delete was the mistake.
3. **Incoming deletion vs the stored session.** If `stored.updated_at >
   deletedAt`, skip — someone edited it after the delete was queued, so the edit
   wins.
4. Everything above happens in **one transaction**. A push either lands whole or
   not at all.

`public/store.js` applies the mirror image of these rules to its local cache, so
both sides converge on the same answer without a second round trip.

### Two details that are easy to get wrong

**`serverTime` is captured before anything is applied, not after.** If it were
taken at the end, a write landing between the read and the stamp would fall in
the gap and never be returned by a later `?since=` pull. The cost is that the
client occasionally re-receives its own writes, which is harmless and idempotent.

**Server-assigned stamps are strictly increasing.** Two writes in the same
millisecond would otherwise be indistinguishable, and `updated_at > since` would
silently drop one of them on the next sync. `db.serverStamp()` bumps by 1ms on a
collision. There is a test for this — `two writes in the same millisecond get
distinct, increasing stamps` — and it fails without the bump.

**Clock skew.** A client `updatedAt` in the future is clamped to now
(`shape.parseSession`), because one phone with a bad clock would otherwise pin
every subsequent sync as "server is stale" forever.

**Tombstone retention** is 180 days (`TOMBSTONE_TTL_DAYS`), pruned on boot. A
device offline longer than that will resurrect a deleted session; deleting it
again is the fix.

## Errors

`400` with `{"error": "..."}` for anything invalid — the message names the
offending field, e.g. `p15[0] must be between 0 and 20`. `401` if the session
cookie is missing or invalid (every route except `/api/health` and
`/api/login`), or if `/api/login` itself gets the wrong username/password.
`429` on more than 120 writes a minute from one IP. `500` with a generic
message; the real error is in the container log.
