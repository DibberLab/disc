#!/usr/bin/env bash
# Nightly SQLite backup for disc.dibberlab.me.
#
# Runs the backup INSIDE the container using better-sqlite3's online backup
# API, so it is WAL-safe and needs no sqlite3 binary on the host.
#
# Install on the droplet:
#   ln -s /var/www/disc/scripts/backup.sh /etc/cron.daily/disc-backup
# or add to root's crontab:
#   15 3 * * * /var/www/disc/scripts/backup.sh >> /var/log/disc-backup.log 2>&1

set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/disc}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/data/backup}"
KEEP="${KEEP:-14}"
STAMP="$(date +%Y-%m-%d)"

mkdir -p "$BACKUP_DIR"
chown 1000:1000 "$BACKUP_DIR"   # the container writes the backup file as uid 1000

docker exec disc node -e "
  const Database = require('better-sqlite3');
  const db = new Database(process.env.DB_FILE, { readonly: true });
  db.backup('/data/backup/disc-${STAMP}.sqlite')
    .then(() => { console.log('backup ok'); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
"

gzip -f "$BACKUP_DIR/disc-${STAMP}.sqlite"

# Keep the most recent $KEEP, drop the rest.
ls -1t "$BACKUP_DIR"/disc-*.sqlite.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm --

echo "$(date -Iseconds) backed up to $BACKUP_DIR/disc-${STAMP}.sqlite.gz"
