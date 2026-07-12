#!/usr/bin/env bash
set -Eeuo pipefail

APP_ROOT=/opt/thinking-pal
RELEASE_ROOT="${APP_ROOT}/releases"
CURRENT_LINK="${APP_ROOT}/current"
UPLOAD_ROOT=/var/tmp/thinking-pal-upload

if [[ "${EUID}" -ne 0 ]]; then
  echo "This command must run through sudo." >&2
  exit 1
fi
if [[ "$#" -ne 3 ]]; then
  echo "Usage: thinking-pal-deploy <git-sha> <archive> <sha256>" >&2
  exit 1
fi

release_id="$1"
archive="$(realpath -e "$2")"
expected_checksum="$3"
if [[ ! "${release_id}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Release id must be a full Git commit SHA." >&2
  exit 1
fi
if [[ "${archive}" != "${UPLOAD_ROOT}/"* ]]; then
  echo "Archive must be below ${UPLOAD_ROOT}." >&2
  exit 1
fi
if [[ ! "${expected_checksum}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Invalid SHA256 checksum." >&2
  exit 1
fi

exec 9>/run/lock/thinking-pal-deploy.lock
flock -n 9 || {
  echo "Another deployment is running." >&2
  exit 1
}

actual_checksum="$(sha256sum "${archive}" | awk '{print $1}')"
if [[ "${actual_checksum}" != "${expected_checksum}" ]]; then
  echo "Release checksum mismatch." >&2
  exit 1
fi

while IFS= read -r entry; do
  case "${entry}" in
    /*|../*|*/../*|*/..) echo "Unsafe archive path: ${entry}" >&2; exit 1 ;;
  esac
done < <(tar -tzf "${archive}")

target="${RELEASE_ROOT}/${release_id}"
staging="$(mktemp -d "${APP_ROOT}/.incoming.XXXXXX")"
cleanup() { rm -rf "${staging}"; }
trap cleanup EXIT
tar --extract --gzip --file "${archive}" --directory "${staging}" --no-same-owner --no-same-permissions

if [[ -n "$(find "${staging}" -type l -print -quit)" ]]; then
  echo "Release archives may not contain symlinks." >&2
  exit 1
fi
for required in web/index.html relay/relay.cjs server/thinking-pal-server; do
  [[ -f "${staging}/${required}" ]] || { echo "Missing release file: ${required}" >&2; exit 1; }
done
chmod 0755 "${staging}/server/thinking-pal-server"
chmod -R u=rwX,go=rX "${staging}"
chown -R root:root "${staging}"

if [[ -e "${target}" ]]; then
  echo "Release ${release_id} already exists; refusing to overwrite it." >&2
  exit 1
fi

previous=""
if [[ -L "${CURRENT_LINK}" ]]; then
  previous="$(readlink -f "${CURRENT_LINK}")"
fi

if [[ -x /usr/local/sbin/thinking-pal-backup && -f /var/lib/thinking-pal/accounts.db ]]; then
  /usr/local/sbin/thinking-pal-backup
fi
mv "${staging}" "${target}"
trap - EXIT

activate() {
  local release_path="$1"
  rm -f "${CURRENT_LINK}.next"
  ln -s "${release_path}" "${CURRENT_LINK}.next"
  mv -Tf "${CURRENT_LINK}.next" "${CURRENT_LINK}"
}

rollback() {
  echo "Deployment health check failed; rolling back." >&2
  if [[ -n "${previous}" && -d "${previous}" ]]; then
    activate "${previous}"
    systemctl restart thinking-pal-api.service thinking-pal-relay.service
  else
    rm -f "${CURRENT_LINK}" "${CURRENT_LINK}.next"
    systemctl stop thinking-pal-api.service thinking-pal-relay.service || true
  fi
  rm -rf "${target}"
}

activate "${target}"
deployment_failed() {
  local code=$?
  trap - ERR
  set +e
  rollback
  exit "${code}"
}
trap deployment_failed ERR
systemctl daemon-reload
systemctl enable thinking-pal-api.service thinking-pal-relay.service
systemctl restart thinking-pal-api.service thinking-pal-relay.service
nginx -t
systemctl reload nginx

healthy=false
for _ in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:8080/healthz >/dev/null &&
     curl --fail --silent http://127.0.0.1:3001/healthz >/dev/null; then
    healthy=true
    break
  fi
  sleep 1
done
if [[ "${healthy}" != true ]]; then
  false
fi
trap - ERR

mapfile -t releases < <(ls -1dt "${RELEASE_ROOT}"/* 2>/dev/null || true)
for ((index=5; index<${#releases[@]}; index++)); do
  candidate="${releases[$index]}"
  [[ "$(readlink -f "${CURRENT_LINK}")" == "${candidate}" ]] || rm -rf "${candidate}"
done
rm -f "${archive}"
echo "Activated Thinking Pal release ${release_id}."
