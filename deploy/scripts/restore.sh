#!/usr/bin/env bash
set -Eeuo pipefail

DATA_ROOT=/var/lib/thinking-pal
APP_USER=thinkingpal

if [[ "${EUID}" -ne 0 ]]; then
  echo "Restore must run as root." >&2
  exit 1
fi
if [[ "$#" -ne 1 ]]; then
  echo "Usage: thinking-pal-restore /var/backups/thinking-pal/daily/<timestamp>" >&2
  exit 1
fi

backup="$(realpath -e "$1")"
case "${backup}" in
  /var/backups/thinking-pal/daily/*|/var/backups/thinking-pal/weekly/*) ;;
  *) echo "Restore source must be inside /var/backups/thinking-pal." >&2; exit 1 ;;
esac
owner="$(stat -c '%u' "${backup}")"
mode="$(stat -c '%a' "${backup}")"
if [[ "${owner}" != 0 ]] || (( 8#${mode} & 8#022 )); then
  echo "Backup must be root-owned and not group/world writable." >&2
  exit 1
fi
[[ -f "${backup}/SHA256SUMS" && -f "${backup}/files.tar.gz" ]] || {
  echo "Invalid Thinking Pal backup." >&2
  exit 1
}
while read -r _ file; do
  file="${file#\*}"
  [[ "${file}" == "accounts.db" || "${file}" == "files.tar.gz" ]] || {
    echo "Unexpected checksum target: ${file}" >&2
    exit 1
  }
done <"${backup}/SHA256SUMS"
(
  cd "${backup}"
  sha256sum --check SHA256SUMS
)
python3 - "${backup}/files.tar.gz" <<'PY'
import pathlib
import sys
import tarfile

with tarfile.open(sys.argv[1], "r:gz") as archive:
    for member in archive.getmembers():
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts:
            raise SystemExit(f"unsafe backup path: {member.name}")
        parts = tuple(part for part in path.parts if part != ".")
        if not parts or parts[0] not in {"docs", "project-memory"}:
            raise SystemExit(f"unexpected backup path: {member.name}")
        if not (member.isfile() or member.isdir()):
            raise SystemExit(f"unsupported backup entry type: {member.name}")
PY

exec 9>/run/lock/thinking-pal-backup.lock
flock -n 9 || { echo "Backup or restore already running." >&2; exit 1; }

recovery="${DATA_ROOT}/.pre-restore-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -o root -g root -m 0700 "${recovery}"
systemctl stop thinking-pal-api.service

restore_previous() {
  echo "Restore failed; putting pre-restore data back." >&2
  systemctl stop thinking-pal-api.service || true
  rm -rf "${DATA_ROOT}/docs" "${DATA_ROOT}/project-memory" \
    "${DATA_ROOT}/accounts.db" "${DATA_ROOT}/accounts.db-wal" "${DATA_ROOT}/accounts.db-shm"
  [[ -e "${recovery}/docs" ]] && mv "${recovery}/docs" "${DATA_ROOT}/docs"
  [[ -e "${recovery}/project-memory" ]] && mv "${recovery}/project-memory" "${DATA_ROOT}/project-memory"
  for path in accounts.db accounts.db-wal accounts.db-shm; do
    [[ -e "${recovery}/${path}" ]] && mv "${recovery}/${path}" "${DATA_ROOT}/${path}"
  done
  chown -R "${APP_USER}:${APP_USER}" \
    "${DATA_ROOT}/docs" "${DATA_ROOT}/project-memory" "${DATA_ROOT}/accounts.db" 2>/dev/null || true
  systemctl start thinking-pal-api.service
}
trap restore_previous ERR

for path in accounts.db accounts.db-wal accounts.db-shm docs project-memory; do
  [[ -e "${DATA_ROOT}/${path}" ]] && mv "${DATA_ROOT}/${path}" "${recovery}/${path}"
done

tar --extract --gzip --file "${backup}/files.tar.gz" --directory "${DATA_ROOT}" --no-same-owner
if [[ -f "${backup}/accounts.db" ]]; then
  install -o "${APP_USER}" -g "${APP_USER}" -m 0640 "${backup}/accounts.db" "${DATA_ROOT}/accounts.db"
fi
chown -R "${APP_USER}:${APP_USER}" "${DATA_ROOT}/docs" "${DATA_ROOT}/project-memory"
systemctl start thinking-pal-api.service

for _ in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:8080/healthz >/dev/null; then
    trap - ERR
    echo "Restore completed from ${backup}. Pre-restore data remains at ${recovery}."
    exit 0
  fi
  sleep 1
done
false
