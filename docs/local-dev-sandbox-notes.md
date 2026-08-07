# Local Dev Notes — Sandbox / Agent Environments

> This supplements the Quick Start in [`docs/README.md`](./README.md) — it doesn't replace it. Read that first for the full picture; this page is specifically about running OpenWA in a container/sandbox environment (e.g. a Claude Code remote session) where Docker is unavailable and there's no phone on hand to pair a real WhatsApp session.

## 1. Purpose & scope

Verified end-to-end in a sandbox with Node v22.22.2 / npm 10.9.7 and no Docker daemon. Covers:
- Getting the API server running natively (no Docker) so you can develop/test against it.
- What "success" looks like when you can't complete WhatsApp pairing.
- Caveats specific to constrained/ephemeral environments.

## 2. Environment constraints

- **Docker daemon is not available in this sandbox.** The `docker` CLI may be present, but `/var/run/docker.sock` doesn't exist, so `docker compose -f docker-compose.dev.yml up -d` and the full `docker-compose.yml` stack **will not work here**. Use the native npm path below instead — OpenWA is designed to need no external services in its minimal config, so this isn't a real limitation.
- Node 22 is required (`.nvmrc`, `engines.node >=22.13`). A sandbox with Node v22.22.2 already satisfies this — no nvm/version juggling needed.
- `DockerService` will log `WARN Docker not available. Container orchestration disabled.` on boot — expected and harmless; it only disables the optional built-in Postgres/Redis/MinIO orchestration feature, not the app itself.

## 3. Exact commands (native npm, no Docker)

```bash
npm ci                          # also runs postinstall: installs dashboard/ deps + patches whatsapp-web.js
cp .env.minimal .env
mkdir -p data/sessions data/media
npm run start:dev               # API only, on :2785 (no dashboard UI unless you `npm run build:all` or `npm run dev`)
```

`npm run dev` instead of `start:dev` also launches the dashboard's Vite dev server (on :2886) concurrently, if you need to work on the UI too.

`.env.minimal` → `.env` gives a zero-config boot: SQLite (`./data/openwa.sqlite`), local disk storage, Redis/queue/cache all disabled, `ENGINE_TYPE=whatsapp-web.js`, `PORT=2785`. Nothing else needs to be set to get the server up.

## 4. What success looks like

```bash
curl http://localhost:2785/api/health
# {"status":"ok","timestamp":"...","version":"0.14.4"}

curl http://localhost:2785/api/health/ready
# {"status":"ok","details":{"mainDatabase":{"status":"up"},"dataDatabase":{"status":"up"}}}
```

Also expect an auto-generated API key logged once on first boot (`AuthService` banner, since `API_MASTER_KEY` is left unset in `.env.minimal`) — it's written to `data/.api-key` for reuse; the process must stay running (not just exit 0) — this is a long-running server, not a script.

## 5. WhatsApp pairing — explicitly out of scope here

Pairing a real WhatsApp session requires scanning a QR code (or entering a pairing code) with an actual phone — this is an inherently human, one-time interactive step and **cannot be automated or verified in a sandbox**. Booting the server and confirming the health endpoints is the correct verification ceiling in this kind of environment. When a human is available: create a session (`POST /api/sessions`), then fetch/display the QR (see the API Example section in `docs/README.md` or the dashboard UI once built).

## 6. Known caveats

- **Puppeteer/Chromium download**: `whatsapp-web.js` bundles Puppeteer, which downloads its own Chromium during `npm ci` unless redirected via `PUPPETEER_SKIP_DOWNLOAD`/`PUPPETEER_EXECUTABLE_PATH`. Expect extra time/disk on first install. Don't redirect it to a pre-installed Chromium of a different distribution (e.g. Playwright's) unless boot actually fails because of it — they aren't guaranteed compatible.
- **`npm run test:e2e`**: the queue-related e2e specs expect a real Redis instance; without one (our minimal config has `QUEUE_ENABLED=false`), those specs fail/skip. That's expected in this setup, not a regression — see `docs/09-testing-strategy.md`.
- **Dashboard UI**: `start:dev` alone leaves the dashboard unbuilt (`⚠️ Dashboard: no build at .../dashboard/dist`) — the API still fully serves `/api/*`; run `npm run build:all` or `npm run dev` if you need the UI too.

## 7. Troubleshooting

See [`docs/12-troubleshooting-faq.md`](./12-troubleshooting-faq.md) and [`docs/10-devops-infrastructure.md`](./10-devops-infrastructure.md) for anything not covered above.

## 8. Relationship to LRMCRM

OpenWA is being prepared as the WhatsApp channel provider for LRMCRM (a separate CRM/loyalty app). See `docs/integration-openwa-whatsapp.md` in the LRMCRM repo for the integration design (LRMCRM's `EspProvider` seam, why OpenWA has to run as an independent always-on service rather than inside LRMCRM's Vercel deployment, and the proposed outbound/inbound API shape).
