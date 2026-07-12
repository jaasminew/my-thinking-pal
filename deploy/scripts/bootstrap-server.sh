#!/usr/bin/env bash
set -Eeuo pipefail

APP_DOMAIN="${APP_DOMAIN:-mythinkingpal.xyz}"
APP_USER="${APP_USER:-thinkingpal}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
APP_ROOT="/opt/thinking-pal"
DATA_ROOT="/var/lib/thinking-pal"
CONFIG_ROOT="/etc/thinking-pal"
CONFIGURE_UFW="${CONFIGURE_UFW:-true}"
SSH_PORT="${SSH_PORT:-22}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi
if [[ -z "${DEPLOY_PUBLIC_KEY:-}" ]]; then
  echo "DEPLOY_PUBLIC_KEY must contain the dedicated GitHub Actions SSH public key." >&2
  exit 1
fi
if [[ ! "${SSH_PORT}" =~ ^[0-9]+$ ]] || (( SSH_PORT < 1 || SSH_PORT > 65535 )); then
  echo "SSH_PORT must be a valid TCP port." >&2
  exit 1
fi

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates curl dnsutils nginx nodejs openssl rsync sqlite3 certbot sudo ufw
node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 20 )); then
  echo "Node.js 20 or newer is required; install a current LTS release and rerun bootstrap." >&2
  exit 1
fi

if ! id "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --home-dir "${DATA_ROOT}" --create-home --shell /usr/sbin/nologin "${APP_USER}"
fi
if ! id "${DEPLOY_USER}" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "${DEPLOY_USER}"
fi

install -d -o root -g root -m 0755 "${APP_ROOT}" "${APP_ROOT}/releases"
install -d -o "${APP_USER}" -g "${APP_USER}" -m 0750 \
  "${DATA_ROOT}" "${DATA_ROOT}/docs" "${DATA_ROOT}/project-memory"
install -d -o root -g "${APP_USER}" -m 0750 "${CONFIG_ROOT}"
install -d -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" -m 0750 /var/tmp/thinking-pal-upload
install -d -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" -m 0700 "/home/${DEPLOY_USER}/.ssh"
printf '%s\n' "${DEPLOY_PUBLIC_KEY}" >"/home/${DEPLOY_USER}/.ssh/authorized_keys"
chown "${DEPLOY_USER}:${DEPLOY_USER}" "/home/${DEPLOY_USER}/.ssh/authorized_keys"
chmod 0600 "/home/${DEPLOY_USER}/.ssh/authorized_keys"

if [[ ! -f "${CONFIG_ROOT}/api.env" ]]; then
  access_secret="$(openssl rand -hex 32)"
  refresh_secret="$(openssl rand -hex 32)"
  sed \
    -e "s|__APP_DOMAIN__|${APP_DOMAIN}|g" \
    -e "s|__JWT_ACCESS_SECRET__|${access_secret}|g" \
    -e "s|__JWT_REFRESH_SECRET__|${refresh_secret}|g" \
    "${DEPLOY_DIR}/env/api.env.example" >"${CONFIG_ROOT}/api.env"
  chown root:"${APP_USER}" "${CONFIG_ROOT}/api.env"
  chmod 0640 "${CONFIG_ROOT}/api.env"
fi
if [[ ! -f "${CONFIG_ROOT}/relay.env" ]]; then
  install -o root -g "${APP_USER}" -m 0640 "${DEPLOY_DIR}/env/relay.env.example" "${CONFIG_ROOT}/relay.env"
fi
if [[ ! -f "${CONFIG_ROOT}/backup.env" ]]; then
  install -o root -g root -m 0600 "${DEPLOY_DIR}/env/backup.env.example" "${CONFIG_ROOT}/backup.env"
fi

install -o root -g root -m 0644 "${DEPLOY_DIR}/systemd/thinking-pal-api.service" /etc/systemd/system/
install -o root -g root -m 0644 "${DEPLOY_DIR}/systemd/thinking-pal-relay.service" /etc/systemd/system/
install -o root -g root -m 0644 "${DEPLOY_DIR}/systemd/thinking-pal-backup.service" /etc/systemd/system/
install -o root -g root -m 0644 "${DEPLOY_DIR}/systemd/thinking-pal-backup.timer" /etc/systemd/system/
install -o root -g root -m 0755 "${DEPLOY_DIR}/scripts/deploy-release.sh" /usr/local/sbin/thinking-pal-deploy
install -o root -g root -m 0755 "${DEPLOY_DIR}/scripts/rollback-release.sh" /usr/local/sbin/thinking-pal-rollback
install -o root -g root -m 0755 "${DEPLOY_DIR}/scripts/backup.sh" /usr/local/sbin/thinking-pal-backup
install -o root -g root -m 0755 "${DEPLOY_DIR}/scripts/restore.sh" /usr/local/sbin/thinking-pal-restore

cat >/etc/sudoers.d/thinking-pal-deploy <<EOF
${DEPLOY_USER} ALL=(root) NOPASSWD: /usr/local/sbin/thinking-pal-deploy, /usr/local/sbin/thinking-pal-rollback
EOF
chmod 0440 /etc/sudoers.d/thinking-pal-deploy
visudo -cf /etc/sudoers.d/thinking-pal-deploy

sed "s|__APP_DOMAIN__|${APP_DOMAIN}|g" \
  "${DEPLOY_DIR}/nginx/thinking-pal-http.conf" >/etc/nginx/sites-available/thinking-pal
ln -sfn /etc/nginx/sites-available/thinking-pal /etc/nginx/sites-enabled/thinking-pal
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl daemon-reload
systemctl enable nginx thinking-pal-backup.timer
systemctl restart nginx
systemctl start thinking-pal-backup.timer

if [[ "${CONFIGURE_UFW}" == true ]]; then
  ufw allow "${SSH_PORT}/tcp"
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
fi

echo "Bootstrap complete."
echo "1. Point the ${APP_DOMAIN} A record at this server and confirm ICP filing."
echo "2. Fill ${CONFIG_ROOT}/api.env and relay.env provider keys."
echo "3. Run: sudo APP_DOMAIN=${APP_DOMAIN} ${DEPLOY_DIR}/scripts/enable-tls.sh"
