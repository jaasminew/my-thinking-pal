#!/usr/bin/env bash
set -Eeuo pipefail

APP_ROOT=/opt/thinking-pal
CURRENT_LINK="${APP_ROOT}/current"

if [[ "${EUID}" -ne 0 ]]; then
  echo "This command must run through sudo." >&2
  exit 1
fi
if [[ "$#" -ne 1 || ! "$1" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Usage: thinking-pal-rollback <full-git-sha>" >&2
  exit 1
fi

exec 9>/run/lock/thinking-pal-deploy.lock
flock -n 9 || { echo "Another deployment is running." >&2; exit 1; }

target="${APP_ROOT}/releases/$1"
[[ -d "${target}" ]] || { echo "Release $1 is not present on this server." >&2; exit 1; }
previous="$(readlink -f "${CURRENT_LINK}")"

activate() {
  rm -f "${CURRENT_LINK}.next"
  ln -s "$1" "${CURRENT_LINK}.next"
  mv -Tf "${CURRENT_LINK}.next" "${CURRENT_LINK}"
}

restore_previous() {
  local code=$?
  trap - ERR
  set +e
  activate "${previous}"
  systemctl restart thinking-pal-api.service
  echo "Rollback failed; restored ${previous}." >&2
  exit "${code}"
}

trap restore_previous ERR
activate "${target}"
systemctl disable --now thinking-pal-relay.service 2>/dev/null || true
systemctl restart thinking-pal-api.service

healthy=false
for _ in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:8080/healthz >/dev/null; then
    healthy=true
    break
  fi
  sleep 1
done
if [[ "${healthy}" != true ]]; then
  false
fi
trap - ERR

echo "Rolled back to $1."
