# Disc golf training log

Tracks the same routine every session: 20 putters at 15 ft and 25 ft, five sets
of 20 at each, then 12 mids and drivers at the net backhand and forehand, five
rounds of 12. Log the sets, watch whether the trend line is going the right way.

Live at **disc.dibberlab.me**.

- **Log a session** — tap +/− through the sets, running totals update as you go.
  Saving twice on the same date corrects that session instead of duplicating it.
- **History** — every session, editable and deletable, with CSV and JSON export.
- **Analytics** — make rate by session with a 5-session trend, average makes by
  set number (the fatigue question), backhand against forehand, and an 18-week
  practice calendar.

Sessions save to the device first and sync to the server when there is a signal,
so logging works at the basket with no bars. Two devices reconcile
last-write-wins; the rules are in `docs/API.md`.

## Running it

```bash
npm install && npm test
docker compose up --build     # http://localhost:8412
```

## Docs

- `CLAUDE.md` — start here: layout, decisions, build order, guardrails
- `docs/REVIEW.md` — review of the original app, what to fix, what to leave alone
- `docs/API.md` — endpoints and the sync merge rules
- `docs/DEPLOY.md` — droplet deploy, start to finish

`legacy/` holds the original single-file app and the spreadsheet it grew out of.
Reference only.
