# Thinking Pal single-server production deployment

This directory deploys `mythinkingpal.xyz` to a single server with Nginx,
systemd, SQLite/file persistence, and GitHub Actions over SSH. The server
address is kept in deployment secrets and is not committed to the repository.

## 1. External prerequisites

1. In the DNS provider, point the `mythinkingpal.xyz` A record at the server.
2. The server is in Tencent Cloud Guangzhou. Complete the domain real-name and
   ICP filing requirements before exposing a public site from mainland China.
3. In the Tencent security group allow inbound TCP 22, 80, and 443 only.
   Port 8080 is loopback-only.
4. Wait until a public resolver returns the expected address:

   ```bash
   dig +short A mythinkingpal.xyz
   ```

At the time the deployment assets were added, public DNS returned `NXDOMAIN`,
port 22 was reachable, port 80 returned an empty response, and port 443 did not
complete a TLS handshake.

## 2. Create the deploy identity

Create a dedicated key locally. Keep the private key out of the repository:

```bash
ssh-keygen -t ed25519 -a 64 -f thinking-pal-deploy -C github-actions-thinking-pal
```

Copy `deploy/` to the server using the administrative SSH account, then run:

```bash
chmod +x /root/thinking-pal-deploy/scripts/*.sh
sudo DEPLOY_PUBLIC_KEY="$(cat thinking-pal-deploy.pub)" \
  APP_DOMAIN=mythinkingpal.xyz \
  SSH_PORT=22 \
  /root/thinking-pal-deploy/scripts/bootstrap-server.sh
```

The bootstrap requires Node.js 20 or newer and stops with an actionable error if
the distribution package is too old. Set `SSH_PORT` before enabling UFW when the
server does not use port 22. The bootstrap is idempotent and creates:

- `thinkingpal`: non-login runtime user.
- `deploy`: SSH upload user with narrowly scoped passwordless deployment commands.
- `/opt/thinking-pal/releases`: immutable application releases.
- `/var/lib/thinking-pal`: SQLite, CRDT documents, and Project Memory data.
- `/etc/thinking-pal`: root-owned runtime configuration.
- `/var/backups/thinking-pal`: local backup generations.

Review `/etc/thinking-pal/api.env`. Add the real `SONIOX_API_KEY` and
`TAVILY_API_KEY`; the bootstrap generates independent JWT secrets automatically.
Never copy these runtime secrets to GitHub.

## 3. Enable HTTPS

After DNS and ICP prerequisites are complete:

```bash
SERVER_IP="your-server-ip"
sudo CERTBOT_EMAIL=admin@mythinkingpal.xyz \
  APP_DOMAIN=mythinkingpal.xyz \
  EXPECTED_IP="${SERVER_IP}" \
  /root/thinking-pal-deploy/scripts/enable-tls.sh
```

This refuses to request a certificate unless public DNS points at the expected
server. Certbot's systemd timer handles renewal.

## 4. Configure GitHub

Create a GitHub Environment named `production` without required reviewers.
Add these Environment secrets:

- `DEPLOY_HOST`: the server IP or SSH hostname
- `DEPLOY_PORT`: `22`
- `DEPLOY_USER`: `deploy`
- `DEPLOY_SSH_KEY`: contents of `thinking-pal-deploy`
- `DEPLOY_KNOWN_HOSTS`: the verified ED25519 host-key line

Obtain the host key, then compare its fingerprint with the Tencent console or an
already trusted administrative SSH session before storing it:

```bash
SERVER_HOST="your-server-host"
ssh-keyscan -p 22 -t ed25519 "${SERVER_HOST}" > known_hosts
ssh-keygen -lf known_hosts
```

Add these Environment variables:

- `APP_DOMAIN`: `mythinkingpal.xyz`
- `DEPLOY_ARCH`: `amd64` or `arm64`, based on `uname -m` on the server

Protect `main`, require pull requests, and require both CI checks (`web` and
`go`) before merge. `.github/workflows/deploy-production.yml` runs only after a
successful `CI` workflow on `main`, uploads a SHA-named release, and invokes the
server's restricted deployment command.

The first release can be started with the workflow's `deploy` manual action.
Later merges to `main` deploy automatically. A failed service health check
atomically restores the previous release. To roll back manually, run the same
workflow with operation `rollback` and a full SHA still present on the server.

## 5. Operations

```bash
# Current status and structured logs
sudo systemctl status thinking-pal-api
sudo journalctl -u thinking-pal-api --since today

# Local health
curl --fail http://127.0.0.1:8080/healthz

# Public health
curl --fail https://mythinkingpal.xyz/healthz

# Releases and timers
readlink -f /opt/thinking-pal/current
systemctl list-timers thinking-pal-backup.timer certbot.timer
```

Nginx access logs intentionally use `$uri`, not `$request_uri`, so WebSocket JWT
query parameters are not written to access logs.

## 6. Backup and restore

The daily timer briefly stops the Go API to take a consistent SQLite + files
snapshot. It keeps seven daily and four weekly generations by default:

```bash
sudo systemctl start thinking-pal-backup.service
sudo journalctl -u thinking-pal-backup.service
sudo /usr/local/sbin/thinking-pal-restore \
  /var/backups/thinking-pal/daily/20260712T023000Z
```

Local backups do not protect against total server loss. Configure
`OFFSITE_TARGET` and the quoted `RSYNC_RSH` example in
`/etc/thinking-pal/backup.env`. Keep the restricted SSH key and pinned
known-hosts file under `/etc/thinking-pal/`, not `/root/.ssh` (the backup unit
has `ProtectHome=true`). The backup root is intentionally fixed at
`/var/backups/thinking-pal` to match the systemd sandbox. Test a restore after
the first deployment and at least quarterly.

## 7. Production acceptance

- HTTPS redirects and certificate renewal work.
- Registration, login, refresh, and logout work.
- A document synchronizes between two browsers over WSS.
- Unknown documents and untrusted WebSocket Origins receive 403.
- STT, Project Memory, authenticated Tavily search (`/search`), and URL cards
  (`/url-meta`) work when signed in.
- Restarting the API preserves accounts and board state.
- A deliberately unhealthy release rolls back automatically.
- A backup can be restored on a clean test directory/server.
