#!/usr/bin/env bash
set -Eeuo pipefail

APP_DOMAIN="${APP_DOMAIN:-mythinkingpal.xyz}"
EXPECTED_IP="${EXPECTED_IP:-}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi
if [[ -z "${EXPECTED_IP}" ]]; then
  echo "EXPECTED_IP must be set to the server's public IP." >&2
  exit 1
fi
resolved="$(dig +short A "${APP_DOMAIN}" | sort -u)"
if ! printf '%s\n' "${resolved}" | grep -Fxq "${EXPECTED_IP}"; then
  echo "${APP_DOMAIN} does not resolve to ${EXPECTED_IP}; current public answers: ${resolved:-none}" >&2
  exit 1
fi

install -d -o www-data -g www-data -m 0755 /var/www/certbot
contact_args=(--register-unsafely-without-email)
if [[ -n "${CERTBOT_EMAIL:-}" ]]; then
  contact_args=(--email "${CERTBOT_EMAIL}")
else
  echo "Warning: CERTBOT_EMAIL is unset; certificate expiry notices are disabled." >&2
fi
certbot certonly \
  --webroot -w /var/www/certbot \
  --domain "${APP_DOMAIN}" \
  "${contact_args[@]}" \
  --agree-tos --non-interactive

sed "s|__APP_DOMAIN__|${APP_DOMAIN}|g" \
  "${DEPLOY_DIR}/nginx/thinking-pal.conf" >/etc/nginx/sites-available/thinking-pal
nginx -t
systemctl reload nginx
systemctl enable --now certbot.timer 2>/dev/null || true

curl --fail --silent --show-error --connect-timeout 5 --max-time 10 \
  --resolve "${APP_DOMAIN}:443:127.0.0.1" "https://${APP_DOMAIN}/healthz" >/dev/null || {
  echo "TLS is active, but the application health endpoint is not ready yet." >&2
}
echo "TLS enabled for https://${APP_DOMAIN}"
