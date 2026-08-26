# Deploying to disc.dibberlab.me

Follows the standing dibberlab workflow: build and preview locally, rsync to
`/var/www/<name>`, reverse-proxy it from nginx, then commit from the server.
Claude never runs on the droplet — everything here is
`ssh dibberlab-droplet '<command>'` from the laptop.

## 0. Before anything: DNS and a free port

```bash
# Point disc.dibberlab.me at 209.97.148.9 first — certbot will fail without it.
dig +short disc.dibberlab.me

# 8412 is the default in .env.example. Confirm nothing already has it:
ssh dibberlab-droplet "ss -ltnp | grep -E ':8412|:8080'"
```

If 8412 is taken, pick another and change it in **both** `.env` and
`deploy/disc.dibberlab.me.conf`. They have to match.

## 1. Preview locally first

Colima, not Docker Desktop — `colima status` before assuming Docker is broken.

```bash
cd ~/dibberlab/disc
npm install
npm test                     # ~44 tests, all should pass
docker compose up --build    # http://localhost:8412
```

Log a session, hard-refresh, confirm it survives. Then open devtools, go offline,
log another, come back online, and watch it push. That is the whole feature.

## 2. Ship it

```bash
rsync -av --delete \
  --exclude node_modules --exclude data --exclude .git --exclude legacy --exclude .env \
  ~/dibberlab/disc/ dibberlab-droplet:/var/www/disc/

ssh dibberlab-droplet "cd /var/www/disc && cp .env.example .env"
```

### The data directory has to be owned by uid 1000

The container runs as the `node` user (uid 1000) and the bind mount replaces
whatever the image had. Skip this and the first boot dies with `SQLITE_CANTOPEN`.

```bash
ssh dibberlab-droplet "mkdir -p /var/www/disc/data && chown -R 1000:1000 /var/www/disc/data"
ssh dibberlab-droplet "cd /var/www/disc && docker compose up -d --build"
ssh dibberlab-droplet "curl -s localhost:8412/api/health"
```

Expect `{"ok":true,...,"sessions":0,...}` before touching nginx.

## 3. nginx

```bash
scp ~/dibberlab/disc/deploy/disc.dibberlab.me.conf \
    dibberlab-droplet:/etc/nginx/sites-available/disc

ssh dibberlab-droplet "ln -s /etc/nginx/sites-available/disc /etc/nginx/sites-enabled/disc"
ssh dibberlab-droplet "nginx -t"                  # must pass first — a bad
ssh dibberlab-droplet "systemctl reload nginx"    # config takes down all ~30 sites
ssh dibberlab-droplet "certbot --nginx -d disc.dibberlab.me"
ssh dibberlab-droplet "nginx -t && systemctl reload nginx"
```

certbot rewrites the file in place to add the `listen 443 ssl` block and the
http→https redirect. Do not hand-write those.

### Then commit nginx — this is not optional

`/etc/nginx` is a live git checkout of `DibberLab/nginx-configs`. The checklist
is **nginx -t → reload → commit → push**, every time:

```bash
ssh dibberlab-droplet "cd /etc/nginx && git add -A && git commit -m 'add disc.dibberlab.me' && git push origin main"
```

Skipping this is how 23 uncommitted config changes piled up in June.

## 4. Give the app its own repo

Nearly every `/var/www/<name>` is its own repo under `github.com/DibberLab/`.
The server checkout is the source of truth — edit there, verify, then commit
**from the server**:

```bash
ssh dibberlab-droplet "cd /var/www/disc && git init && git add -A && git commit -m 'initial'"
ssh dibberlab-droplet "cd /var/www/disc && git remote add origin git@github.com:DibberLab/disc.git && git push -u origin main"
```

`.gitignore` already excludes `data/`, `node_modules/` and `.env`. Check it
before the first `git add -A` — never `cat >` an existing `.gitignore`, read and
append, or a real `.env` gets swept in.

## 5. Nightly backup

There is no other copy of this data. Set it up the same day you deploy.

```bash
ssh dibberlab-droplet "ln -s /var/www/disc/scripts/backup.sh /etc/cron.daily/disc-backup"
ssh dibberlab-droplet "/var/www/disc/scripts/backup.sh"    # run it once by hand
ssh dibberlab-droplet "ls -la /var/www/disc/data/backup"
```

It runs SQLite's online backup API inside the container (WAL-safe, no sqlite3
binary needed on the host), gzips it, and keeps 14. `data/backup/` is inside the
gitignored `data/`, so backups are on the same droplet as the database — fine
against an app bug, useless against losing the droplet. Worth pointing at
Spaces or the repo-backup cron eventually.

## 6. Create the first account

The whole app requires login now — there's no signup form, so the first
account has to be created by hand once. `scripts/` isn't copied into the
image (the Dockerfile only ships `server/` and `public/`), so this runs on
the **host**, against the bind-mounted data file, not `docker compose exec`:

```bash
ssh dibberlab-droplet "cd /var/www/disc && DB_FILE=./data/disc.sqlite node scripts/create-user.js andy"
```

It prompts for a password (input hidden) and upserts on username, so it's
also how you reset a forgotten password or add another person later. SQLite's
WAL mode makes this safe to run while the container is up.

## Updating later

```bash
rsync -av --delete --exclude node_modules --exclude data --exclude .git --exclude legacy --exclude .env \
  ~/dibberlab/disc/ dibberlab-droplet:/var/www/disc/
ssh dibberlab-droplet "cd /var/www/disc && docker compose up -d --build && git add -A && git commit -m '<msg>' && git push"
```

**`--exclude .env` is not optional.** `.env` only ever exists on the droplet —
it is gitignored and never in the local tree, so `--delete` without this
exclude removes it on every single update.

Migrations run automatically on boot — `server/db.js` applies any `NNN_*.sql` in
`server/migrations/` it has not seen and records it in `schema_migrations`. Add
new files, never edit `001_init.sql` once it has run anywhere real. Accounts
and their password hashes live in the `users` table in the SQLite file itself,
not in `.env` — losing `.env` no longer has anything to do with login.

## If it will not start

```bash
ssh dibberlab-droplet "cd /var/www/disc && docker compose logs --tail 50"
```

- `SQLITE_CANTOPEN` → the uid 1000 ownership step in §2.
- `502` from nginx → the container is down, or `proxy_pass` and `PORT_HOST` disagree.
- Healthcheck flapping → `curl localhost:8412/api/health` on the droplet directly.
