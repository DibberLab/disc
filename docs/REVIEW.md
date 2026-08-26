# Review of the original app

Reviewed: `disc-golf-tracker.html` (single file) and `app/` (unbundled), which
were byte-identical in substance. Both are preserved in `legacy/`.

The app was in good shape. Most of what follows is small, and the section at the
bottom lists the parts that are already right so nobody "fixes" them.

---

## Bugs to fix

**1. Sample data lands on the wrong day after ~6pm Central.** `#sample` builds
dates with `new Date(base.getTime() - d * 86400000).toISOString().slice(0, 10)`,
where `base` is `new Date()` — the current time of day. Once local time passes
19:00 CDT / 18:00 CST, UTC has already rolled over, so every generated date is a
day late. `renderHeat()` and `streak()` use the same `toISOString().slice(0,10)`
pattern; those anchor at `T12:00:00` local so they are safe in Chicago, but they
break for anyone east of UTC+12 and they are the same latent mistake.

*Fix:* one helper, used everywhere a Date becomes a `YYYY-MM-DD` string. The
existing `today()` already does it correctly — generalise it:

```js
function isoLocal(d) {
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
```

Then replace every `toISOString().slice(0, 10)` in `app.js` with `isoLocal(...)`.
Dates in this app are calendar days in Andy's timezone, never instants.

**2. `normalize()` on JSON import turns garbage into `NaN`.** `+v` on `"abc"`
gives `NaN`; `Math.max(0, Math.min(max, NaN))` is `NaN`; `JSON.stringify` then
writes it as `null`. It happens to self-heal, but the server now validates
strictly, so a hand-edited backup will be accepted locally and rejected on
push — and local and server quietly diverge. Make `normalize()` reject
non-integers the way `server/shape.js` does.

**3. The date field has no upper bound.** One fat-fingered `2087-08-26` stretches
every chart's x-axis and there is no obvious way to see what happened. Set
`max` on `#date` to today at boot.

## Data model decisions, made deliberately

**4. One session per calendar date.** Enforced by `UNIQUE(date)` on `sessions`,
matching the old "saving twice on the same date updates it" behaviour. If two
sessions in one day is ever wanted, that is a migration (add a sequence number
or move to a surrogate key), not a config change. Flagging it because it is the
single hardest thing to change later.

**5. A skipped set and a set where nothing went in are different things,** and
the app was already careful about this. The schema keeps it: a skipped set has
**no row** in `session_sets`; a set thrown and missed entirely is a row with
`made = 0`. Do not "simplify" that to a nullable column with zeros.

**6. Station definitions live in three places** — `GRIDS` in `public/app.js`,
`STATIONS` in `server/config.js`, and the `CHECK` constraint in
`001_init.sql`. Changing a max or a set count means changing all three in one
commit. There is a comment saying so in `config.js`.

## Analytics nits

**7. "Best 15 ft day" is really "most made in a day"** and renders as `/100`.
A session where only three sets were thrown can never win it, and its `/100`
denominator is wrong. Either relabel it, or compare rates across sessions where
all five sets were thrown.

## Security, now that it is on the public internet

This app went from "a file on your phone" to "a URL anyone can find," which
changes the threat model even though nothing about the code got less safe.

**8. There is no login.** Per the decision made up front, `disc.dibberlab.me`
is open: anyone who finds it can add, edit, or wipe sessions. Two things are
in place for that — `DG_WRITE_TOKEN` (wired up, off by default; set it and every
write needs the header) and `scripts/backup.sh` (nightly, keeps 14). If the URL
ever gets shared or indexed, turn the token on. See `docs/DEPLOY.md`.

**9. Notes are stored raw and escaped at render time.** That is correct — but it
means the server must never template a note into HTML. Keep notes flowing
through JSON only.

**10. The container binds to `127.0.0.1`, not `0.0.0.0`.** nginx is the only
thing that should reach it. There is a comment on that line in
`docker-compose.yml`; do not change it to a bare port mapping.

## Housekeeping

**11. Two copies of the app were being maintained by hand.** The single-file
`disc-golf-tracker.html` and the `app/` directory had to be edited in lockstep,
with the README instructing a human to re-inline three files after every change.
That drifts eventually. `public/` is now the only copy; the old single file is in
`legacy/` for reference. If a single-file offline build is still wanted, it
should be a script, not a twin.

## Accessibility and polish, low priority

- The tab strip has `role="tab"` but no `tabpanel` roles, no `aria-controls`,
  and no arrow-key navigation between tabs.
- `confirm()` and `alert()` for deletes, wipes and import results. Fine for a
  personal tool; a small inline confirmation would be nicer on a phone.
- No service worker. With a server behind it now, a stale-while-revalidate
  worker would make "Add to Home Screen" genuinely launchable with no signal,
  rather than needing one online load first.

## What was already right

Worth stating so none of it gets undone:

- Percentages divide by the sets **actually thrown**, so a half session reports
  an honest number instead of being punished for the sets that were skipped.
- Notes are escaped through `esc()` before going into the history table.
- The charts are hand-rolled dependency-free SVG — nothing to keep patched, and
  they scale properly. They were carried over untouched.
- Upsert-by-date, so re-saving a day corrects it instead of duplicating it.
- The `localStorage` failure path already degraded to memory and told the user,
  which is exactly the seam the new offline layer needed.
