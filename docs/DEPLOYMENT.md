# Deploying Atrium

Atrium is a single Node.js process with a single SQLite file. There is no
database server, cache, queue, or build step. Everything below assumes a
fresh Linux box (Ubuntu 24.04 works).

## What you need

| Requirement | Minimum | Notes |
|---|---|---|
| CPU / RAM | 1 vCPU / 1 GB | comfortable to hundreds of users |
| Disk | 10 GB | `./data` holds the DB + uploads; grows with usage |
| Runtime | Node.js ≥ 22.5 **or** Docker 24+ | `node:sqlite` is built in |
| TLS | required for public use | Caddy/nginx; federation requires https |
| Domain | only for public use | LAN/Tailscale needs none |

Optional: SMTP is **not** used. Backups are file copies (see below).

## Option A — Docker (recommended)

```bash
git clone <your-fork> atrium && cd atrium
docker compose up -d --build
```

App is on `http://localhost:3000`; data persists in the `atrium-data` volume.

For a public deployment, edit `deploy/Caddyfile` to your domain and uncomment
the `caddy` service in `docker-compose.yml`:

```bash
ATRIUM_PUBLIC_URL=https://chat.example.com ATRIUM_TRUST_PROXY=true docker compose up -d --build
```

## Option B — Bare metal / VM

```bash
# Node 22.5+ (https://github.com/nodesource/distributions)
git clone <your-fork> atrium && cd atrium
npm install
```

`/etc/systemd/system/atrium.service`:

```ini
[Unit]
Description=Atrium
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/atrium
Environment=PORT=3000
Environment=ATRIUM_PUBLIC_URL=https://chat.example.com
Environment=ATRIUM_TRUST_PROXY=true
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=3
# Hardening (optional but sensible):
User=atrium
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/atrium/data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now atrium
```

TLS with Caddy (`apt install caddy`), `/etc/caddy/Caddyfile`:

```
chat.example.com {
	reverse_proxy localhost:3000
}
```

`sudo systemctl reload caddy` — certificates are automatic. WebSocket
upgrades pass through Caddy and nginx with no extra configuration.

## First-run

Open the URL. Atrium shows a setup wizard (create the first account), then
onboarding (create a workspace or join with an invite code). That's it.

## Configuration reference

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `ATRIUM_DATA_DIR` | `./data` | SQLite + uploads |
| `ATRIUM_PUBLIC_URL` | `http://localhost:PORT` | Own public URL — **required for federation** |
| `ATRIUM_TRUST_PROXY` | `false` | `true` when behind Caddy/nginx (correct client IPs for rate limits) |
| `ATRIUM_DISABLE_REGISTRATION` | off | `1` = invite-only server (first account always allowed) |
| `ATRIUM_ALLOW_LOCAL_FEDERATION` | off | Dev only: federation to private/localhost URLs |
| `ATRIUM_ALLOW_LOCAL_CALLBACKS` | off | Dev only: app callbacks to private URLs |
| `ATRIUM_ALLOW_LOCAL_UNFURL` | off | Dev only: unfurl local URLs |

## Upgrades

```bash
git pull && npm install
# Docker: docker compose up -d --build
systemctl restart atrium
```

Database migrations are versioned and run automatically at boot. Back up
`./data` before upgrading (below).

## Backups

Everything lives in `./data`. A consistent one-off backup:

```bash
sqlite3 data/atrium.db ".backup 'backups/atrium-$(date +%F).db'"
```

or just stop the service and copy the directory. Cron example (nightly, keep 14):

```cron
17 3 * * * sqlite3 /opt/atrium/data/atrium.db ".backup '/opt/atrium/backups/atrium.db'" && find /opt/atrium/backups -name 'atrium.db*' -mtime +14 -delete
```

Hetzner users: enabling server snapshots is a one-toggle alternative.

## Federation between two deployments

1. Both servers need valid TLS and `ATRIUM_PUBLIC_URL` set correctly.
2. Workspace A admin: workspace menu → **Connect workspace…** → create invite code.
3. Workspace B admin: same modal → redeem with server A's URL + code.
4. Share channels into the connection from the channel browser; external DMs
   work from the DM picker. Full protocol: [FEDERATION.md](FEDERATION.md).

## Production checklist

- [ ] TLS terminating at Caddy/nginx with a real domain
- [ ] `ATRIUM_PUBLIC_URL` matches the public URL exactly (no trailing slash)
- [ ] `ATRIUM_TRUST_PROXY=true` (only when behind the proxy)
- [ ] Registration policy chosen (open vs `ATRIUM_DISABLE_REGISTRATION=1`)
- [ ] systemd unit / compose `restart: unless-stopped`
- [ ] Nightly backup of `./data`
- [ ] Uptime check on `/api/v1/health`
- [ ] Desktop app: users run it with `ATRIUM_URL=https://chat.example.com npm start` (see `desktop/`)

## Scaling notes

Atrium is single-process by design: SQLite (single writer), in-memory
presence and rate limiting. Scale vertically — 2 vCPU / 4 GB covers
thousands of users. Horizontal scaling (shared DB, pub/sub presence) is a
documented future item; federation is the current answer to spanning
communities across deployments.
