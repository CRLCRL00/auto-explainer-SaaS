#!/usr/bin/env bash
# auto-explainer-saas — daily db backup
#
# Cron:
#   0 3 * * *  /srv/auto-explainer/shared/backup-db.sh
#
# Backups:
#   - pg_dump from auto-explainer-pg docker container → /srv/auto-explainer/storage/backups/db-YYYYMMDD-HHMMSS.sql.gz
#   - Keep 14 days (auto-prune older)
#   - chmod 600 (only readable by ubuntu / root)
#
# Failure:
#   - Log to /srv/auto-explainer/storage/logs/backup.log
#   - Exit non-zero (cron will email if MAILTO is configured)

set -euo pipefail
set -o errtrace
trap 'echo "[$(date -Iseconds)] backup FAILED at line $LINENO" >> /srv/auto-explainer/storage/logs/backup.log; exit 1' ERR

# Load secrets (DB password from .deploy-secrets)
SECRETS=/srv/auto-explainer/shared/.deploy-secrets
if [[ ! -r "$SECRETS" ]]; then
  echo "[$(date -Iseconds)] backup ABORTED: cannot read $SECRETS" >&2
  exit 2
fi
source "$SECRETS"

BACKUP_DIR=/srv/auto-explainer/storage/backups
LOG_FILE=/srv/auto-explainer/storage/logs/backup.log
KEEP_DAYS=14
TS=$(date +%Y%m%d-%H%M%S)
OUT=$BACKUP_DIR/db-$TS.sql.gz

mkdir -p "$BACKUP_DIR"
touch "$LOG_FILE"
chmod 600 "$LOG_FILE"

echo "[$(date -Iseconds)] backup starting → $OUT" >> "$LOG_FILE"

# pg_dump via docker exec (no psql needed on host, pg lives in container)
sudo docker exec auto-explainer-pg pg_dump -U aesaas -d aesaas --no-owner --clean --if-exists \
  | gzip -c > "$OUT"

# chmod (gzip preserves umask)
chmod 600 "$OUT"

# Stats
SIZE=$(stat -c %s "$OUT")
echo "[$(date -Iseconds)] backup OK: $OUT ($SIZE bytes)" >> "$LOG_FILE"

# Prune old (keep last N days)
find "$BACKUP_DIR" -name 'db-*.sql.gz' -mtime +$KEEP_DAYS -delete
COUNT=$(find "$BACKUP_DIR" -name 'db-*.sql.gz' | wc -l)
echo "[$(date -Iseconds)] prune done; remaining backups: $COUNT" >> "$LOG_FILE"
