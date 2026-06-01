# OpenWA VPS Docker Deployment

This bundle is intended for a clean Ubuntu 24.04 VPS.

## Stack

- `openwa-api`: NestJS API with `whatsapp-web.js` and Chromium.
- `postgres`: PostgreSQL 16 for OpenWA user data.
- `dashboard`: React dashboard served by nginx.
- `caddy`: public reverse proxy for `/api/*`, `/socket.io/*`, and the dashboard.

Persistent data:

- PostgreSQL: Docker volume `openwa_postgres-data`.
- WhatsApp sessions and media: `./data`.

## Install On The VPS

From the project directory:

```bash
sudo bash scripts/install-ubuntu-docker-vps.sh
```

The script installs Docker, copies the project to `/opt/openwa`, creates `/opt/openwa/.env`, generates a PostgreSQL password, opens ports 80/443 when `ufw` is active, and starts the stack.

## Manual Commands

```bash
cp .env.vps.example .env
docker compose -f docker-compose.vps.yml up -d --build
docker compose -f docker-compose.vps.yml ps
docker compose -f docker-compose.vps.yml logs -f --tail=120
```

## Domain And HTTPS

For first boot by IP, keep:

```env
OPENWA_SITE_ADDRESS=:80
BASE_URL=http://YOUR_SERVER_IP
DASHBOARD_URL=http://YOUR_SERVER_IP
```

For automatic HTTPS, point the domain DNS A record to the VPS and set:

```env
OPENWA_SITE_ADDRESS=openwa.example.com
BASE_URL=https://openwa.example.com
DASHBOARD_URL=https://openwa.example.com
CORS_ORIGINS=https://openwa.example.com
```

Then restart:

```bash
docker compose -f docker-compose.vps.yml up -d
```
