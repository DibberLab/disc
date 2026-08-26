# API contract

Base path `/api`. JSON in, JSON out. Single user, no login (see
`docs/REVIEW.md` §8). All timestamps are ISO-8601 UTC with milliseconds —
`2026-08-26T14:03:11.212Z` — always that exact width, because the sync rules
compare them as **strings** and fixed width is what makes `<` chronological.

## The session shape

Identical to what `public/app.js` has always held in memory, plus `updatedAt`:

```json
{
  "date": "2026-08-26",
  "p15": [18, 17, null, 16, 15],
  "p25": [11, 9, null, 10, 8],
  "bh":  [7, 8, 6, null, 7],
  "fh":  [5, 6, 4, null, 5],
  "notes": "headwind out of the north",
  "updatedAt": "2026-08-26T14:03:11.212Z"
}
```

`null` means that set was not thrown. `0` means it was thrown and nothing went
in. These are different and the whole percentage model depends on the
difference. Arrays are always length 5.

Putting stations (`p15`, `p25`) take 0–20. Net stations (`bh`, `fh`) take 0–12.
The server **rejects** out-of-range values rather than clamping them — the
client clamps at the input, so anything out of range on the wire is a bug worth
seeing.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/health` | `{ok, serverTime, sessions, sets, deletions, lastUpdatedAt}`. Docker healthcheck hits this. |
| `GET` | `/api/sessions` | `{serverTime, sessions[]}`, oldest first. |
| `GET` | `/api/sessions?since=ISO` | Only sessions with `updated_at > since`. |
| `GET` | `/api/sessions/:date` | One session, or `404`. |
| `PUT` | `/api/sessions/:date` | Upsert. `201` created, `200` updated, `400` invalid. Path date wins over body date. |
| `DELETE` | `/api/sessions/:date` | `204` if it existed, `404` if not. Writes a tombstone either way. |
| `POST` | `/api/sync` | The offline reconciliation endpoint. See below. |
| `GET` | `/api/export.json` | The same envelope the old "Back up as JSON" button produced, so exports restore in either direction. |

Still to build (`TODO(claude-code)` markers are in the code):

| `GET` | `/api/export.csv` | Column order must match the Session Log tab of the spreadsheet. Lift the list from `#exportCsv` in `public/app.js`; do not reinvent it. |
| `POST` | `/api/import` | `{sessions[], mode: "merge"｜"replace"}`. Must run every session through `shape.parseSession`. |

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
offending field, e.g. `p15[0] must be between 0 and 20`. `401` if
`DG_WRITE_TOKEN` is set and `X-DG-Token` is missing or wrong. `429` on more than
120 writes a minute from one IP. `500` with a generic message; the real error is
in the container log.
