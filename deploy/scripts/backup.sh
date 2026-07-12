#!/usr/bin/env bash
set -Eeuo pipefail

[[ -f /etc/thinking-pal/backup.env ]] && source /etc/thinking-pal/backup.env
BACKUP_ROOT=/var/backups/thinking-pal
DAILY_RETENTION_DAYS="${DAILY_RETENTION_DAYS:-7}"
WEEKLY_RETENTION_DAYS="${WEEKLY_RETENTION_DAYS:-28}"
DATA_ROOT=/var/lib/thinking-pal

if [[ "${EUID}" -ne 0 ]]; then
  echo "Backup must run as root." >&2
  exit 1
fi

exec 9>/run/lock/thinking-pal-backup.lock
flock -n 9 || { echo "Another backup is running." >&2; exit 1; }

install -d -o root -g root -m 0700 "${BACKUP_ROOT}/daily" "${BACKUP_ROOT}/weekly"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
temporary="$(mktemp -d "${BACKUP_ROOT}/.backup-${timestamp}.XXXXXX")"
final="${BACKUP_ROOT}/daily/${timestamp}"
api_was_active=false

cleanup() {
  rm -rf "${temporary}"
  if [[ "${api_was_active}" == true ]]; then
    systemctl start thinking-pal-api.service
  fi
}
trap cleanup EXIT

if systemctl is-active --quiet thinking-pal-api.service; then
  api_was_active=true
  systemctl stop thinking-pal-api.service
fi

if [[ -f "${DATA_ROOT}/accounts.db" ]]; then
  sqlite3 "${DATA_ROOT}/accounts.db" ".timeout 10000" ".backup '${temporary}/accounts.db'"
fi
tar --create --gzip --file "${temporary}/files.tar.gz" \
  --directory "${DATA_ROOT}" docs project-memory
(
  cd "${temporary}"
  : >SHA256SUMS
  [[ ! -f accounts.db ]] || sha256sum accounts.db >>SHA256SUMS
  sha256sum files.tar.gz >>SHA256SUMS
)
cat >"${temporary}/metadata.txt" <<EOF
created_at=${timestamp}
hostname=$(hostname)
format=1
EOF
chmod -R u=rwX,go= "${temporary}"
mv "${temporary}" "${final}"
trap - EXIT

if [[ "${api_was_active}" == true ]]; then
  systemctl start thinking-pal-api.service
fi

if [[ "$(date -u +%u)" == "7" ]]; then
  cp -al "${final}" "${BACKUP_ROOT}/weekly/${timestamp}"
fi
find "${BACKUP_ROOT}/daily" -mindepth 1 -maxdepth 1 -type d -mtime "+${DAILY_RETENTION_DAYS}" -exec rm -rf {} +
find "${BACKUP_ROOT}/weekly" -mindepth 1 -maxdepth 1 -type d -mtime "+${WEEKLY_RETENTION_DAYS}" -exec rm -rf {} +

if [[ -n "${OFFSITE_TARGET:-}" ]]; then
  rsync --archive --protect-args "${BACKUP_ROOT}/daily/" "${OFFSITE_TARGET%/}/daily/"
  rsync --archive --protect-args "${BACKUP_ROOT}/weekly/" "${OFFSITE_TARGET%/}/weekly/"
else
  echo "Warning: OFFSITE_TARGET is empty; this backup exists only on the production server." >&2
fi

echo "Backup completed: ${final}"
