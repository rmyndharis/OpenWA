<p align="center">
  <img src="docs/logo/openwa_logo.webp" alt="OpenWA Logo" width="200"/>
</p>

<h1 align="center">OpenWA</h1>
<p align="center">
  <strong>Open Source WhatsApp API Gateway</strong>
</p>

<p align="center">
  <a href="#-features">Features</a> •
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-documentation">Docs</a> •
  <a href="#-api-examples">API</a> •
  <a href="#-contributing">Contributing</a>
</p>

<p align="center">
  <a href="https://github.com/rmyndharis/OpenWA/actions/workflows/ci.yml"><img src="https://github.com/rmyndharis/OpenWA/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"/></a>
  <img src="https://img.shields.io/github/package-json/v/rmyndharis/OpenWA?label=version&color=blue" alt="Version"/>
  <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License"/>
  <img src="https://img.shields.io/badge/node-22_LTS-brightgreen.svg" alt="Node"/>
  <img src="https://img.shields.io/github/package-json/dependency-version/rmyndharis/OpenWA/@nestjs/core?label=NestJS&color=red" alt="NestJS"/>
  <img src="https://img.shields.io/badge/docker-ready-blue.svg" alt="Docker"/>
  <img src="https://img.shields.io/github/package-json/dependency-version/rmyndharis/OpenWA/dev/typescript?label=TypeScript&color=3178C6" alt="TypeScript"/>
  <a href="https://buymeacoffee.com/rmyndharis"><img src="https://img.shields.io/badge/Buy_Me_a_Coffee-support-FFDD00?logo=buymeacoffee&logoColor=black" alt="Buy Me a Coffee"/></a>
</p>

---

## ✨ Why OpenWA?

**OpenWA** is a free, open-source WhatsApp API Gateway designed for developers who need full control over their messaging infrastructure—without vendor lock-in or hidden paywalls.

Built on a **pluggable architecture**, OpenWA lets you select database engines (SQLite/PostgreSQL), media storage backends (Local/S3), and cache layers (disabled/Redis) through configuration rather than application-code changes. The storage backend is the live store for status media and, when chat-media archiving is enabled, archived chat media; other message media is returned inline to API and webhook consumers. `scripts/backup.sh` copies only the local media directory, so an S3 bucket needs a backup of its own.

|                               |                                                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 🔓 **100% Open Source**       | No licensing fees, no feature locks, full source code access                                                                             |
| 🏗️ **Pluggable Architecture** | Swap adapters for database, storage, and cache via config                                                                                |
| 🖥️ **Full Dashboard**         | Modern React UI for session, webhook, and API key management                                                                             |
| 🔹 **Multi-Session Ready**    | Run multiple WhatsApp sessions concurrently on one instance                                                                              |
| 🐳 **Docker Native**          | Production-ready with zero configuration                                                                                                 |
| 🧩 **Official Plugins**       | Chatwoot, Typebot & more as sandboxed plugins on the Integration Fabric — [OpenWA-plugins](https://github.com/rmyndharis/OpenWA-plugins) |
| 🔗 **n8n Integration**        | Community nodes for workflow automation                                                                                                  |
| 🧩 **Community Adapters**     | Third-party integrations (e.g. ioBroker) — see [docs](./docs/23-community-integrations.md)                                               |
| 🔐 **Session-scoped keys**    | Operator and viewer (reader) tokens can be limited to chosen sessions — or all sessions if none are selected                             |
| 🔒 **Chat-scoped keys**       | Those same tokens can also be limited to chosen chats — a few groups and contacts — so an agent on a shared account sees only its own    |

### Session-scoped operator & viewer tokens

When you create or edit an **operator** or **viewer** API key in the dashboard, you can tick the WhatsApp sessions that key may use.

- **No sessions selected** — the key can access every session, including ones created later.
- **One or more sessions selected** — the key can only list, read, and (for operator) manage those sessions. A request naming any other session returns `403` ("API key not authorized for this session"); session-filtered lists (sessions, audit, webhook delivery failures) return that key's rows rather than an error; and the key-management routes and the queue dashboard, which name no session at all, return `403`.

Admin keys stay unscoped in the dashboard so they can keep managing other API keys. The HTTP API still accepts `allowedSessions` on any role if you need that from a client.

### Chat-scoped operator & viewer tokens

A session-scoped key still reaches every chat on the sessions it may use. A key can be narrowed further, to **chats** (a chosen set of groups and individual contacts), with `allowedChats` on `POST /auth/api-keys` or `PUT /auth/api-keys/{id}`. The dashboard sets it on operator and viewer keys (one chat id or phone number per line) and shows each key's chat count in the list.

- **No chats selected** — the key can reach every chat on its sessions.
- **One or more selected** — the key reaches only those chats. Every authenticated REST route not explicitly marked as safe for a chat-scoped key refuses it with `403` (a request naming a session outside `allowedSessions` is refused first, with `403 "API key not authorized for this session"`), including routes added in later releases: the refusal is the default. Inside its chats an operator key can do what the marked routes allow, which is more than reading and sending: it can also delete or clear a chat, leave or rename a group, and block the contact. It cannot change who belongs to a group: adding, removing, promoting or demoting participants, answering join requests and reading or resetting the invite link all stay closed.
- **The two scopes are independent** — a key may be limited to sessions, to chats, to both, or to neither.

This lets you point an **AI agent or third-party integration at a shared account** without handing it every chat. Give the agent a key scoped to the few groups (or DMs) it is meant to handle: it can send and reply there, but it cannot list your other chats, read any other DM, message a contact outside its set, or reach the queue dashboard. It reads its chats' stored messages on either engine through `GET /sessions/{sessionId}/messages?chatId=`, where `chatId` is required for such a key, and live history through `GET /sessions/{sessionId}/messages/{chatId}/history` on whatsapp-web.js only. It receives no pushed events, so it has to poll. It can still read the session's own status (`GET /sessions/{sessionId}`) so an integration can tell whether it is connected.

Identity is matched through the lid mapping table: a contact allowlisted by phone number also matches the same person's `@lid` privacy id once the table maps the two, and an unmapped `@lid` is refused rather than guessed. A lid's digits are never mistaken for a phone number, so `555000111@lid` does not admit `555000111@c.us`.

The default covers REST routes only. Surfaces that authenticate outside the REST guard do not inherit it, so each one that can return chat data refuses a chat-scoped key with its own check: the `/events` WebSocket, the MCP mount (per tool call), and the Bull Board queue dashboard. Four list routes are usable, each filtered to the key's chats before paging: `GET /sessions/{sessionId}/chats`, `GET /sessions/{sessionId}/groups` (id, name and community parent id only), `GET /sessions/{sessionId}/contacts` and `GET /sessions/{sessionId}/labels/{labelId}/chats`.

The API also accepts `allowedChats` on an admin key, but no admin-only route is open to a chat-scoped key, and the last usable admin key cannot be scoped this way.

None of this changes the ban-risk guidance below. It limits what a _key_ can reach, not what WhatsApp makes of the account.

---

## ⚠️ Before you connect a number — please read

OpenWA is an unofficial, community-maintained gateway. It connects to WhatsApp through **reverse-engineered clients** (the [`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js) project and [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys)), **not** through Meta's official Cloud API. This has real consequences you should understand before you link a phone number.

### What this means in practice

- **There is always a non-zero risk of account restriction or ban.** WhatsApp's anti-abuse systems actively look for unofficial automation. No amount of code quality on our side can make that risk zero.
- **Pick the right number.** Never connect your primary personal or business number to an automated gateway. Use a **dedicated number** you can afford to lose. If you're running this for paying clients, pass that guidance on to them.
- **The two engines trade off differently:**

  | Engine            | Ban-risk profile                                                                                        | Resource cost                     |
  | ----------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------- |
  | `whatsapp-web.js` | Lower — drives a real headless Chromium that looks like genuine WhatsApp Web traffic.                   | High RAM (~300–500 MB / session). |
  | `baileys`         | Higher — speaks the multi-device WebSocket protocol directly and is easier for WhatsApp to fingerprint. | Low RAM (~30–80 MB / session).    |

  If account safety is your top priority and you can afford the memory, prefer `whatsapp-web.js`. If you need density and accept the trade-off, use `baileys`.

### Safe-sending guidelines

These are practical guardrails, not guarantees — but they materially reduce the chance of WhatsApp flagging the account:

1. **Warm up fresh numbers.** For the first several days, behave like a normal human user: scan the QR, exchange a handful of messages with saved contacts, join a group or two, set a profile photo. Don't blast on day one.
2. **Don't cold-blast strangers.** Sending the first-ever message to a large batch of numbers that have never messaged you is the single most reliable way to get restricted — on either engine.
3. **Pace sends per session.** Set `SEND_PACING_ENABLED=true` (off by default) for a per-session daily cap: an allowance that grows with the session's age (`SEND_PACING_WARMUP_SCHEDULE`), a separate cap on new conversations (`SEND_PACING_COLD_DAILY_CAP`) and a consecutive-failure breaker; [R002 in the risk guide](docs/16-risk-management.md#r002-user-account-banned) lists what it counts. No per-minute cap is enforced, so spacing within a day is up to the caller: bulk sends wait `delayBetweenMessages` between messages, and single text sends pause behind a typing indicator (`SIMULATE_TYPING`, on by default). A few messages per minute per session is sustainable; "thousands in an hour" is not. The `RATE_LIMIT_*` variables are API abuse protection, counted per route and client IP, not a send cap: they throttle dashboard and read traffic too.
4. **Use opted-in recipients.** The safest workloads are replies and alerts to people who already expect to hear from you (OTP to your own users, order updates, support replies).
5. **Keep a fallback.** For anything auth-critical or revenue-critical, keep an SMS / email / official-Cloud-API path. Do not bet a login flow solely on an unofficial client.
6. **Mind the hosting IP.** Cheap datacenter IPs are flagged more aggressively than residential ones. A residential proxy (supported per-session via the proxy settings) can help; it is not a license to spam.

### Known platform behaviour (not bugs)

A few things that look like bugs but are actually server-side WhatsApp policy, not OpenWA defects — we track them separately so we can distinguish them from real bugs:

- **First message to a brand-new contact sometimes never arrives.** The API returns success because the message leaves OpenWA, but WhatsApp's server-side reach-out / trust policy drops it at delivery. This is independent of OpenWA. We track it in [#830](https://github.com/rmyndharis/OpenWA/issues/830).
- **Accounts that get restricted cannot be "unrestricted" by us.** If WhatsApp disables a number, you need to appeal through their channels — OpenWA has no lever to pull.
- **Some accounts cannot link a new device at all.** WhatsApp has added a passkey step to companion linking for some accounts: the phone asks to "Create a passkey" or "Continue on your other device" and the session stays at `qr_ready`. Neither engine implements that step, so switching engine or using a pairing code does not help, and no OpenWA setting changes it. Avoid logging out or re-linking a session that works, since linking it again may hit the same gate, and keep the fallback from rule 5 above. See [the FAQ entry](docs/12-troubleshooting-faq.md#issue-linking-asks-for-a-passkey-and-never-completes-both-engines); tracked in [#560](https://github.com/rmyndharis/OpenWA/issues/560).

### Compliance

For any deployment where ethical, legal, or regulatory compliance matters (healthcare, finance, large-scale commercial messaging, anything touching end users in the EU/EEA under DMA/GDPR framings), treat OpenWA as **not approved** and use Meta's [official WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api). OpenWA is an excellent fit for personal projects, internal tooling, automation hobbyists, and learning — it is not a drop-in replacement for the official API in regulated environments.

📖 For the deeper, maintainer-side risk analysis (protocol-change exposure, dependency strategy, security posture), see [Risk Management (`docs/16`)](./docs/16-risk-management.md).

---

## 🎯 Features

### Core Features

| Feature       | Status | Description                                                                  |
| ------------- | ------ | ---------------------------------------------------------------------------- |
| REST API      | ✅     | Full WhatsApp API via HTTP endpoints                                         |
| Multi-Session | ✅     | Manage multiple WhatsApp accounts                                            |
| Webhooks      | ✅     | Real-time events with HMAC signature and optional smart pre-dispatch filters |
| Web Dashboard | ✅     | Visual management interface                                                  |
| API Key Auth  | ✅     | Secure API authentication                                                    |
| Swagger Docs  | ✅     | Interactive API documentation                                                |

### Messaging

| Feature           | Status | Description                                               |
| ----------------- | ------ | --------------------------------------------------------- |
| Text Messages     | ✅     | Send/receive text messages                                |
| Media Messages    | ✅     | Images, videos, documents, audio                          |
| Message Reactions | ✅     | React to messages with emoji                              |
| Message Editing   | ✅     | Send edits + live `message.edited` events on both engines |
| Bulk Messaging    | ✅     | Send to multiple recipients                               |
| Message Status    | ✅     | Track delivery and read receipts                          |

### Advanced

| Feature             | Status | Description                                                                                                                                                                  |
| ------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Groups API          | ✅     | Create, manage, join (invite code), and configure groups                                                                                                                     |
| Profile Management  | ✅     | Set own display name, about text, and profile picture                                                                                                                        |
| Call Handling       | ✅     | `call.received` events (not reliable on whatsapp-web.js), reject calls and per-session auto-reject (Baileys only)                                                            |
| Channels/Newsletter | ✅     | WhatsApp Channels support                                                                                                                                                    |
| Labels Management   | ✅     | Organize chats with labels                                                                                                                                                   |
| Proxy Support       | ✅     | Per-session proxy configuration                                                                                                                                              |
| Rate Limiting       | ✅     | Configurable request limits                                                                                                                                                  |
| CIDR Whitelisting   | ✅     | IP-based access control                                                                                                                                                      |
| Chat Scoping        | ✅     | Per-key `allowedChats` allowlist (groups and contacts): a key reaches only those chats, and routes not marked safe for it refuse it                                          |
| Audit Logging       | ✅     | Audit trail for API-key, session, integration-instance, and infra admin operations (message sends and webhook deliveries are tracked in their own tables, not the audit log) |

### Infrastructure

| Feature          | Status | Description                                      |
| ---------------- | ------ | ------------------------------------------------ |
| SQLite           | ✅     | Zero-config embedded database                    |
| PostgreSQL       | ✅     | Production-grade database                        |
| Redis Cache      | ✅     | Optional performance caching                     |
| S3/MinIO Storage | ✅     | Live media store (statuses, archived chat media) |
| Docker           | ✅     | One-command deployment                           |
| Health Checks    | ✅     | Kubernetes-ready probes                          |
| Data Migration   | ✅     | Export/import between backends                   |

---

## 🚀 Quick Start

### Option A: Docker (Recommended)

```bash
# Clone and start
git clone https://github.com/rmyndharis/OpenWA.git
cd OpenWA
docker compose -f docker-compose.dev.yml up -d

# Access (the dashboard is bundled into the API image and served on the same port)
# Dashboard: http://localhost:2785
# API: http://localhost:2785/api
# Swagger: http://localhost:2785/api/docs
```

**Your API key.** The first boot generates an admin API key, prints it once in the log and stores it at
`/app/data/.api-key` inside the container. Read it with `docker exec openwa-api cat /app/data/.api-key`,
then use it to sign in to the dashboard and as the `X-API-Key` header wherever this README shows
`YOUR_API_KEY`. Later boots log only a masked prefix. See [API Key](docs/README.md#api-key).

> **Using Podman instead of Docker?**
> Podman rootless mode requires the socket to be running and `DOCKER_HOST` to be set:
>
> ```bash
> systemctl --user start podman.socket
> systemctl --user enable podman.socket
> export DOCKER_HOST=unix:///run/user/$(id -u)/podman/podman.sock
> ```
>
> Add the `export` line to your `~/.bashrc` to make it permanent.

### Option B: Local Development

```bash
# Clone repository
git clone https://github.com/rmyndharis/OpenWA.git
cd OpenWA

# Install the locked dependencies (includes dashboard)
npm ci

# Start API + Dashboard (config is auto-generated on first run)
npm run dev

# Access (in dev the dashboard runs on the Vite server with hot reload)
# Dashboard: http://localhost:2886
# API: http://localhost:2785/api
# Swagger: http://localhost:2785/api/docs
```

The first boot writes the admin API key to `data/.api-key` (read it with `cat data/.api-key`).

Use `npm install` instead when intentionally changing dependencies. OpenWA's committed lockfile uses
registry artifacts only, so npm 12 works with its secure default that blocks Git dependencies; do not
disable that policy globally.

---

## 🔒 Security Architecture

### Docker Socket Proxy

The production stack never exposes `/var/run/docker.sock` directly to the application container. Instead, a dedicated `docker-proxy` sidecar (based on [`tecnativa/docker-socket-proxy`](https://github.com/Tecnativa/docker-socket-proxy)) acts as the sole gateway to the Docker daemon:

```
openwa-api  ──TCP 2375──▶  docker-proxy  ──unix──▶  /var/run/docker.sock
```

Only the operations needed for container orchestration are enabled (`CONTAINERS`, `IMAGES`, `VOLUMES`, `INFO`, `PING`, plus the `POST` method switch). The application connects via the `DOCKER_HOST=tcp://docker-proxy:2375` environment variable, which `DockerService` detects automatically. Note this is an operational gateway, not a fine-grained privilege boundary: with `POST` enabled the proxy admits every method to the enabled paths and cannot scope container-create payloads, so a compromised API container would be host-root-equivalent — see `SECURITY.md` for the full threat model, mitigations, and how to disable the proxy if you don't use the built-in datastore orchestration.

### Non-root Container Execution

The production image never runs the Node.js process as root. On startup, the container follows this chain:

```
dumb-init (PID 1)
  └─ docker-entrypoint.sh (root — fixes named-volume ownership via chown)
       └─ gosu openwa node dist/main  (drops to the openwa user)
```

- **dumb-init** is PID 1 and forwards signals (SIGTERM, etc.) for graceful shutdown.
- **docker-entrypoint.sh** runs as root only long enough to `chown` the named-volume mount points so the `openwa` user can write to them.
- **gosu** performs a clean `exec`-based privilege drop — no `su` or `sudo` wrappers, so the node process is the direct child of dumb-init.

Named volumes (e.g. `openwa-data`) get their ownership corrected automatically on every start, so no manual `chown` step is needed after volume creation.

The image can also start as the `openwa` user directly (uid/gid 997: `--user 997:997`, or the Helm chart's `podSecurityContext`). The entrypoint then skips the `chown` and the `gosu` drop and needs no added capabilities, provided `/app/data` is writable by that uid.

---

## 🏭 Production Deployment

For production, use the main `docker-compose.yml` with optional services:

```bash
# Basic production (SQLite, local storage)
docker compose up -d

# Also start the PostgreSQL container (configure it first, see below)
docker compose --profile postgres up -d

# Also start PostgreSQL, Redis and MinIO (configure them first, see below)
docker compose --profile full up -d
```

| Profile    | Services                                        |
| ---------- | ----------------------------------------------- |
| `postgres` | PostgreSQL database                             |
| `redis`    | Redis cache                                     |
| `minio`    | S3-compatible storage (MinIO fork `pgsty/silo`) |
| `full`     | All services above                              |

A profile only starts the container; OpenWA keeps using SQLite and local storage until it is told
to use the new service. The simplest route is **Dashboard > Infrastructure**: pick the built-in
option, save, and restart from there, and OpenWA starts the container itself. The built-in storage
option creates its own `openwa-minio` container, so do not also start the `minio` or `full` profile
for it. The same goes for built-in PostgreSQL and Redis: each built-in option creates its own
container, and the compose profiles are for the manual `.env` route below. The compose `minio`
service starts only once `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are set in the `.env` next to
`docker-compose.yml`; if it was already started without them, run `docker rm -f openwa-minio` before
you enable built-in storage. To use a profile directly, set these in the `.env` next to
`docker-compose.yml` first:

- PostgreSQL: `DATABASE_TYPE=postgres`, `DATABASE_HOST=postgres`, `DATABASE_USERNAME=openwa`,
  `DATABASE_PASSWORD=<strong password>`
- Redis: `REDIS_ENABLED=true`, `REDIS_HOST=redis`
- MinIO: `STORAGE_TYPE=s3`, `S3_ENDPOINT=http://minio:9000`, `S3_ACCESS_KEY_ID=<user>`,
  `S3_SECRET_ACCESS_KEY=<strong password>`

PostgreSQL refuses to initialize a new volume with an empty password, MinIO refuses to start
without one, and a production boot rejects default credentials such as `openwa` or `minioadmin`.

> The dashboard is bundled into the API image and served by NestJS on the API port, so it
> needs no profile — it is always available wherever `openwa-api` runs. For TLS/public exposure,
> put your own reverse proxy (nginx, Caddy, a cloud load balancer, or a k8s Ingress) in front;
> see the nginx example in `docs/12-troubleshooting-faq.md`.

> **Development vs Production**
>
> - Development (`docker-compose.dev.yml`): SQLite, local storage, API serves the bundled dashboard
> - Production (`docker-compose.yml`): Configurable database, profiles for optional services
>
> Official GHCR images are published as multi-arch manifests for:
>
> - `linux/amd64`
> - `linux/arm64`

To run a published image instead of building from source, add a `docker-compose.override.yml` next to
`docker-compose.yml`:

```yaml
services:
  openwa-api:
    image: ghcr.io/rmyndharis/openwa:latest
```

Run `docker compose pull openwa-api && docker compose up -d --no-build`. To upgrade, update the checkout
first (`git pull`, or `git checkout v<version>` when pinning), then run the same command: the override
replaces only the image, and `docker-compose.yml` forwards an explicit variable list with no `env_file`,
so an outdated copy drops the variables a newer release adds and keeps the old service definitions. Pin a
release by replacing `latest` with its version number. Once the image is pulled, Compose runs it and
builds nothing. The service keeps its `build:` section, so if the pull fails (a mistyped tag, no registry
access) Compose falls back to building from source and tags that build with the published name;
`--no-build` makes that case fail instead. For the same reason, do not use `--build` or
`docker compose build` with this override.

## 🔌 Ports

| Service         | Port            | Description                                                                         |
| --------------- | --------------- | ----------------------------------------------------------------------------------- |
| API & Dashboard | `2785`          | REST API + bundled web dashboard (same port)                                        |
| Swagger         | `2785/api/docs` | Interactive API docs — off under `NODE_ENV=production` unless `ENABLE_SWAGGER=true` |
| Dashboard (dev) | `2886`          | Vite dev server with hot reload (`npm run dev`)                                     |

---

## 📡 API Examples

Replace `YOUR_API_KEY` with your admin key (see [Quick Start](#-quick-start) for where to find it).

### Create a Session

```bash
curl -X POST http://localhost:2785/api/sessions \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{"name": "my-bot"}'
```

### Start Session & Get QR Code

```bash
# Start the session
curl -X POST http://localhost:2785/api/sessions/{sessionId}/start \
  -H "X-API-Key: YOUR_API_KEY"

# Get QR code (scan with WhatsApp)
curl http://localhost:2785/api/sessions/{sessionId}/qr \
  -H "X-API-Key: YOUR_API_KEY"
```

### Send a Message

```bash
curl -X POST http://localhost:2785/api/sessions/{sessionId}/messages/send-text \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{
    "chatId": "628123456789@c.us",
    "text": "Hello from OpenWA!"
  }'
```

### Setup Webhook

```bash
curl -X POST http://localhost:2785/api/sessions/{sessionId}/webhooks \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{
    "url": "https://your-server.com/webhook",
    "events": ["message.received", "session.status"],
    "secret": "your-hmac-secret"
  }'
```

> **Smart filters (optional):** add a `filters` object to fire the webhook only when conditions match
> (AND), e.g. `{ "conditions": [{ "field": "sender", "operator": "is", "value": ["1234567890@c.us"] }] }`.
> Fields: `sender` / `recipient` / `chatId` / `body` / `type` / `mentions` / `fromMe` / `hasMedia` /
> `isGroup` / `kind`. A webhook with no filters behaves exactly as before. Use `chatId` to allowlist
> specific groups or DMs (e.g. `{ "field": "chatId", "operator": "is", "value": ["120…@g.us"] }`).
> See the API specification for the full schema.

## 🤖 MCP Server (AI Agents)

OpenWA can expose a **curated set of tools over the [Model Context Protocol](https://modelcontextprotocol.io)** so AI agents (Claude, Cursor, …) can drive WhatsApp. It is **off by default** and **additive** — every REST route keeps working unchanged.

Set `MCP_ENABLED=true` to mount a stateless Streamable-HTTP transport at **`POST /mcp`** on the existing server (same port, no extra process). It mounts **25 read-only tools** by default — session, message, contact, group, webhook, label and automation-rule _reads_ — because the surface is read-only unless you opt out. Add `MCP_READONLY=false` to mount all **51 tools**, adding the write tier (send, reply, group operations). Either way it is a focused surface rather than the full API, so agents aren't overwhelmed.

```bash
MCP_ENABLED=true npm run start:prod   # or set MCP_ENABLED in your .env / compose
```

Point an MCP client at it (e.g. for Claude Code, a `.mcp.json` at your project root):

```json
{
  "mcpServers": {
    "openwa": {
      "type": "http",
      "url": "http://localhost:2785/mcp",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}
```

The key can be passed as `Authorization: Bearer …` or `X-API-Key: …`. Every tool call goes through the **same API-key auth, role, and per-session scoping** as REST.

**Security guidance:**

- **Mint a dedicated, least-privilege key** for the agent — a non-admin, **session-scoped** key (`OPERATOR` role at most). The plaintext key is shown only once on creation; to rotate, create a new key and delete the old one.
- The key **must not** carry an IP allow-list (`allowedIps`) — there is no genuine client IP over MCP, so such a key is rejected.
- Set **`MCP_READONLY=true`** to mount only the read tools (no sends/writes).
- Set **`MCP_RATE_LIMIT_MAX`** (default `60`) to limit tool calls per API key per window.
- Set **`MCP_RATE_LIMIT_WINDOW_MS`** (default `60000`) to control the sliding window size in milliseconds.
- **Do not expose `/mcp` to the public internet** without a fronting auth proxy. For a self-hosted, locally-reached deployment the static API key is appropriate; public exposure should use OAuth 2.1 (not yet built).

---

## 🛠 Tech Stack

| Layer         | Technology                                              |
| ------------- | ------------------------------------------------------- |
| **Runtime**   | Node.js 22 LTS                                          |
| **Framework** | NestJS 11.x                                             |
| **Language**  | TypeScript 6.x                                          |
| **WA Engine** | whatsapp-web.js (default) / baileys — set `ENGINE_TYPE` |
| **Database**  | SQLite / PostgreSQL                                     |
| **Cache**     | Redis (optional)                                        |
| **Storage**   | Local / S3 / MinIO                                      |
| **ORM**       | TypeORM                                                 |
| **Container** | Docker + Docker Compose                                 |

---

## 📁 Project Structure

```
openwa/
├── src/
│   ├── main.ts                 # Application entry point
│   ├── app.module.ts           # Root module
│   ├── config/                 # Configuration
│   ├── common/                 # Shared utilities
│   │   ├── cache/              # Redis caching
│   │   └── storage/            # File storage (Local/S3)
│   ├── core/                   # Core systems
│   │   ├── hooks/              # Plugin hooks
│   │   └── plugins/            # Plugin system
│   ├── engine/                 # WhatsApp engine abstraction
│   └── modules/
│       ├── session/            # Session management
│       ├── message/            # Message handling
│       ├── webhook/            # Webhook management
│       ├── group/              # Groups API
│       ├── contact/            # Contacts API
│       ├── auth/               # API key authentication
│       ├── infra/              # Infrastructure management
│       └── health/             # Health checks
├── dashboard/                  # React web dashboard
├── docs/                      # Documentation
├── docker-compose.yml
├── Dockerfile
└── package.json
```

---

## 📚 Documentation

Comprehensive documentation is available in the `docs/` folder:

| Document                                                | Description                  |
| ------------------------------------------------------- | ---------------------------- |
| [Project Overview](./docs/01-project-overview.md)       | Introduction and goals       |
| [Requirements](./docs/02-requirements-specification.md) | Feature specifications       |
| [Architecture](./docs/03-system-architecture.md)        | System design                |
| [Security](./docs/04-security-design.md)                | Security implementation      |
| [Database](./docs/05-database-design.md)                | Data models and migrations   |
| [API Spec](./docs/06-api-specification.md)              | Complete API reference       |
| [Development](./docs/08-development-guidelines.md)      | Coding standards             |
| [Migration Guide](./docs/14-migration-guide.md)         | Database & storage migration |

---

## 🤝 Contributing

We welcome contributions! Here's how to get started:

1. **Fork** the repository
2. **Create** your feature branch (`git checkout -b feat/amazing-feature`)
3. **Commit** your changes (`git commit -m 'Add amazing feature'`)
4. **Push** to the branch (`git push origin feat/amazing-feature`)
5. **Open** a Pull Request

Please read our [Development Guidelines](./docs/08-development-guidelines.md) for coding standards and best practices.

---

## ☕ Support

OpenWA is free and open source. If it saves you time or helps your business, you can support its development by buying me a coffee.

<a href="https://buymeacoffee.com/rmyndharis"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me a Coffee" height="50"/></a>

---

## Disclaimer

OpenWA is an independent open-source project and is not affiliated, associated, authorized, endorsed by, or in any way officially connected with Meta Platforms, Inc., WhatsApp LLC, or any of their subsidiaries or affiliates. The official WhatsApp website can be found at [whatsapp.com](https://www.whatsapp.com). The name "WhatsApp" as well as related names, marks, emblems, and images are registered trademarks of their respective owners.

Use it at your own risk; you are responsible for complying with WhatsApp's terms and the law where you operate.

---

## 📄 License

This project is licensed under the **MIT License** – free for personal and commercial use.

See [LICENSE](./LICENSE) for details.

---

<div align="center">

**OpenWA** – Free, Open Source WhatsApp API Gateway

[📖 Documentation](./docs/README.md) · [🔌 API Docs](http://localhost:2785/api/docs) · [🐛 Report Bug](https://github.com/rmyndharis/OpenWA/issues) · [💡 Request Feature](https://github.com/rmyndharis/OpenWA/issues)

<br/>

<sub>Made with ❤️ by <a href="https://github.com/rmyndharis">Yudhi Armyndharis</a> and the OpenWA Community</sub>

</div>
