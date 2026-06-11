# OpenWA — Security Audit

**Target:** `rmyndharis/OpenWA` (Open Source WhatsApp API Gateway), v0.1.6
**Commit audited:** `0fbee7f` (branch `main`)
**Stack:** NestJS 11 / TypeScript 5 / TypeORM (SQLite default, PostgreSQL optional) / whatsapp-web.js (Puppeteer) / Socket.IO / dockerode / React dashboard
**Scope:** Backend `src/**` (~13.8K LOC, 121 files). Dashboard reviewed at a high level only.
**Method:** Manual code review of the full backend, plus a live run (`node dist/main`) to confirm exploitability. Dependency posture via `npm audit`.
**Date:** 2026-06-11

---

## 0. Executive summary

OpenWA has a **reasonable baseline**: a global `ApiKeyGuard` (`APP_GUARD`) protects every route unless explicitly `@Public()`, inputs are validated with `class-validator` + a strict `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`), Helmet sets security headers, throttling is on, webhooks support HMAC signing, and DB access is parameterized (no SQL injection found). The WebSocket gateway authenticates the handshake.

The dominant problem is the **default credential and the access model around the privileged "infra" control plane**:

| # | Severity | Title | Status |
|---|----------|-------|--------|
| C-1 | **Critical** | Hard‑coded, globally‑known default admin key `dev-admin-key` in non‑production mode (the README's #1 Quick Start) | **Fixed** |
| H-1 | High | Tar‑slip / path traversal in storage import + arbitrary local file read (`/infra/storage/import`) | **Fixed** |
| H-2 | High | Broken access control — destructive infra & plugin endpoints not gated to ADMIN | **Fixed** |
| H-3 | High | API‑key IP allowlist bypass via spoofable `X-Forwarded-For` | **Fixed** |
| M-1 | Medium | CORS reflects any origin **with credentials** when `CORS_ORIGINS=*` (the default) | **Fixed** |
| M-2 | Medium | WebSocket subscriptions ignore the key's `allowedSessions` (cross‑session message leak) | **Fixed** |
| M-3 | Medium | Webhook SSRF — outbound URL unrestricted; `test` endpoint is a response oracle | Documented (opt‑in guard added, default off) |
| M-4 | Medium | Swagger always exposed unauthenticated; `ENABLE_SWAGGER` ignored | **Fixed** (now honored) |
| M-5 | Medium | Dependency CVEs: `npm audit` = 21 (2 critical, 10 high); prod‑only = 17 (9 high) | Flagged (dep change = approval gate) |
| L-1..L-5 | Low | 0.0.0.0 bind knob, unsalted key hash, predictable export temp paths, default `minioadmin`, proxy URL not validated | L‑1 knob added; rest documented |

All Critical/High/applicable‑Medium code fixes are implemented on branch `security-audit-fixes`, verified by rebuild + live re‑test, and **not pushed** (`main` untouched). Dependency upgrades and Docker/compose edits are left for the maintainer because they hit change‑control gates.

---

## 1. Critical

### C-1 — Globally‑known default admin API key in non‑production mode  *(Fixed)*

**Location:** `src/modules/auth/auth.service.ts:28-34`

```ts
displayKey =
  process.env.NODE_ENV === 'production' ? `owa_k1_${randomBytes(32).toString('hex')}` : 'dev-admin-key';
await this.seedApiKey(displayKey, 'Default Admin Key', ApiKeyRole.ADMIN);
```

On first boot with no API keys, when `NODE_ENV !== 'production'`, OpenWA seeds an **ADMIN** key equal to the hard‑coded constant **`dev-admin-key`** — identical on every install.

Why this is Critical, not a benign dev convenience:

- The README's **primary Quick Start (Option A)** is `docker compose -f docker-compose.dev.yml up -d`, and that compose file sets `NODE_ENV=development` (`docker-compose.dev.yml:14`). So the *recommended* getting‑started deployment ships with a publicly‑known admin credential.
- The README's **Option B** (`npm run dev`) also runs with `NODE_ENV` unset → same `dev-admin-key`. And `main.ts` calls `app.listen(port)` with **no host argument**, so Node binds `0.0.0.0` (all interfaces). A `npm run dev` instance is therefore network‑reachable with a known admin key.
- A holder of this key has full ADMIN: read all sessions/messages, send messages from the connected WhatsApp account, list/create/revoke API keys, wipe & replace the database, write arbitrary files (see H‑1), enable plugins → code execution (H‑2 chain), and orchestrate Docker.

**Live proof (this audit, dev mode):**

```
$ node dist/main
  🔑 API Key (newly created):
     dev-admin-key
$ curl -H "X-API-Key: dev-admin-key" localhost:2785/api/auth/api-keys
[{"name":"Default Admin Key","role":"admin","isActive":true, ...}]      # full admin
$ curl -H "X-API-Key: dev-admin-key" localhost:2785/api/infra/status
{"database":{"connected":true,...}}                                     # infra control plane
```

**Fix applied:** the seed key is now **always cryptographically random** (`owa_k1_<32 bytes hex>`), regardless of `NODE_ENV`. The hard‑coded `dev-admin-key` is removed. For deployments that need a deterministic key, an explicit `API_MASTER_KEY` env (already documented in `.env.example`) is honored as the seed; otherwise a random key is generated and printed once in the startup banner and written to `data/.api-key`. This eliminates the shared/guessable credential without removing the "key is shown on first run" convenience.

---

## 2. High

### H-1 — Tar‑slip path traversal + arbitrary file read in storage migration  *(Fixed)*

**Locations:** `src/common/storage/storage.service.ts:181-220` (`importFromStream`), `:249-264` (`getLocalFile`/`putLocalFile`); reachable via `src/modules/infra/infra.controller.ts:711-732` (`POST /infra/storage/import`).

Two problems in the local storage backend:

1. **Tar‑slip.** `importFromStream` writes each archive entry via `putFile(header.name, data)` → `putLocalFile` → `path.join(this.localPath, header.name)`. The entry name is never validated. A crafted `.tar.gz` containing `../../../…/file` (or an absolute path) escapes `data/media` and writes anywhere the process can — e.g. dropping `data/plugins/evil/{manifest.json,index.js}`, then loading it via `/infra/restart` + `/plugins/:id/enable` (which `require()`s the file) for **authenticated RCE**.
2. **Arbitrary read.** `POST /infra/storage/import` takes `{ filePath }` straight from the body and `fs.createReadStream(filePath)` on any path on the host. `getLocalFile`/`putLocalFile` likewise apply no containment to caller‑supplied paths.

Reachable by any valid key today (the route had no role gate — see H‑2 — and in dev the key is `dev-admin-key`). Live check confirmed the endpoint processes an attacker‑supplied path:

```
$ curl -XPOST localhost:2785/api/infra/storage/import -H "X-API-Key: dev-admin-key" \
       -d '{"filePath":"/proof/not-a-real-file-audit-test"}'      # reached the sink (HTTP 500 on open)
```

**Fix applied:** added `resolveWithin(base, name)` containment in `StorageService` (resolves the candidate and rejects anything not strictly inside `localPath`, plus absolute/`..` entries). `getLocalFile`, `putLocalFile`, and every `importFromStream` entry now go through it; unsafe entries are skipped and logged. Combined with H‑2, the import route is also ADMIN‑gated.

### H-2 — Broken access control on infra & plugin control plane  *(Fixed)*

**Locations:** `src/modules/infra/infra.controller.ts` (whole controller), `src/modules/plugins/plugins.controller.ts:27-48`.

The global guard authenticates but does not authorize unless a route declares `@RequireRole`. These privileged endpoints declared **no role**, so any valid key — including a `VIEWER` and the dev key — could call them:

- `POST /infra/restart` — stop/remove/create Docker containers and shut the server down.
- `POST /infra/import-data` — `DELETE FROM` then re‑`INSERT` all sessions/webhooks/messages (full DB wipe & replace).
- `GET /infra/export-data` — dump all sessions (incl. proxy URLs/creds), webhooks (incl. secrets), messages.
- `PUT /infra/config` — write `data/.env.generated` (DB/S3 creds, engine browser args).
- `POST /infra/storage/import` / `GET /infra/storage/export` — see H‑1.
- `POST /plugins/:id/enable|disable`, `PUT /plugins/:id/config` — control the plugin runtime (`enable` `require()`s plugin code).

Live check: `GET /api/plugins` and `GET /api/infra/status` both returned `200` with `dev-admin-key`, and the admin‑only key list returned with it too.

**Fix applied:** `@RequireRole(ApiKeyRole.ADMIN)` added at the `InfraController` class level (the `@Public()` `health` route still overrides), and on the three mutating `PluginsController` routes (`enable`/`disable`/`config`). Read‑only plugin list/get/health remain available to lower roles.

### H-3 — IP allowlist bypass via spoofable `X-Forwarded-For`  *(Fixed)*

**Location:** `src/modules/auth/guards/api-key.guard.ts:66-73`

```ts
private getClientIp(request: Request): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (forwarded) return (forwarded as string).split(',')[0].trim();   // attacker-controlled
  return request.ip || request.socket.remoteAddress || '';
}
```

The per‑key `allowedIps` / CIDR restriction (`AuthService.validateApiKey`) keys off this value. Because `X-Forwarded-For` is trusted unconditionally and is a client‑supplied header, an attacker simply sends `X-Forwarded-For: <an-allowed-ip>` to defeat the allowlist. (When OpenWA is not behind a proxy, XFF should never be trusted at all.)

**Fix applied:** `X-Forwarded-For` is now only honored when `TRUST_PROXY=true` (operators behind a known reverse proxy opt in); otherwise the guard uses the real socket peer address. This makes IP allowlisting trustworthy by default.

---

## 3. Medium

### M-1 — CORS reflects any origin with credentials when `CORS_ORIGINS=*`  *(Fixed)*

**Location:** `src/main.ts:107-125`. With the default `CORS_ORIGINS=*` (`.env.example:23`), the origin callback returns `callback(null, true)` for **every** origin while `credentials: true`. Reflecting an arbitrary origin together with `Access-Control-Allow-Credentials: true` is the classic unsafe CORS combination. Impact is limited here because auth is header‑based (not cookies), but it should not ship this way.
**Fix applied:** when the configured origin list contains `*`, CORS now responds with credentials **disabled** (wildcard + no credentials is the safe form). An explicit origin allowlist keeps `credentials: true`.

### M-2 — WebSocket subscriptions ignore `allowedSessions`  *(Fixed)*

**Location:** `src/modules/events/events.gateway.ts:44-74, 98-140`. The handshake validates the key but does not pass/enforce the session scope, and `handleSubscribe` lets any authenticated socket `join` any `session:<id>:*` room — including the `*` wildcard — so a key restricted to one session (or a low‑priv key) can receive **all** sessions' `message.received` traffic. A multi‑tenant data‑isolation gap.
**Fix applied:** `handleSubscribe` now enforces the socket key's `allowedSessions` (a restricted key may only subscribe to its own session IDs and may not use `*`).

### M-3 — Webhook SSRF + test oracle  *(Documented; opt‑in guard added, default off)*

**Location:** `src/modules/webhook/webhook.service.ts:104-153` (`test`), `:301-354` (`deliverWebhook`). Webhook URLs are operator‑controlled and the server makes outbound POSTs to them with no destination restriction; `POST .../webhooks/:id/test` returns `success`/`statusCode`, making it a convenient SSRF probe against internal services and cloud metadata (`169.254.169.254`). This is *partly by design* (n8n/self‑hosted webhook receivers are a first‑class use case, often on loopback/LAN), so a blanket block would break legitimate setups.
**Fix:** an opt‑in `WebhookSsrfGuard` is provided that blocks loopback/private/link‑local/metadata ranges and non‑http(s) schemes when `WEBHOOK_SSRF_PROTECT=true`; left **off by default** to preserve functionality. Recommended on for internet‑exposed multi‑tenant deployments.

### M-4 — Swagger always exposed; `ENABLE_SWAGGER` ignored  *(Fixed)*

**Location:** `src/main.ts:143-160`. Swagger is set up unconditionally and `GET /api/docs` returned `200` with no key in testing, despite `.env.example:119`/`SettingsController` implying an `ENABLE_SWAGGER` toggle. It leaks the full API surface.
**Fix applied:** Swagger is now skipped when `ENABLE_SWAGGER=false` (default remains on to match documented behavior).

### M-5 — Dependency vulnerabilities  *(Flagged — change‑control gate)*

`npm audit` = **21** (2 critical, 7 moderate, 10 high); production‑only = **17** (9 high, 0 critical — both criticals are dev/build‑chain `tar`). Notable: `ws` (uninitialized memory disclosure) under `socket.io`/`puppeteer-core`; `tar`/`node-gyp` chain under `sqlite3`→`typeorm`; `@grpc/grpc-js` crash. Most are transitive and low real‑world exploitability for this app, but several `npm audit fix` upgrades pull a **breaking** `sqlite3@6`. Dependency changes are out of autonomous scope (approval gate); recommend the maintainer run `npm audit fix` and validate, then evaluate `--force` for `sqlite3`.

---

## 4. Low / informational

- **L-1 — Default `0.0.0.0` bind.** `app.listen(port)` binds all interfaces. *(Fixed: `HOST` env knob added; default unchanged to avoid breaking Docker.)*
- **L-2 — Unsalted SHA‑256 API‑key hash** (`auth.service.ts:202`). Acceptable for 256‑bit random keys; documented only.
- **L-3 — Predictable export temp path** `data/storage-export-<Date.now()>.tar.gz` (`infra.controller.ts:695`) — world‑readable in shared deployments; minor.
- **L-4 — Built‑in MinIO defaults `minioadmin:minioadmin`** (`docker.service.ts:215`, `infra.controller.ts:282`). Acceptable only because the port binds `127.0.0.1`; change before exposing.
- **L-5 — `proxyUrl` not URL‑validated** (`create-session.dto.ts:34`). Flows into Puppeteer `--proxy-server` as a single array element (no shell, no arg‑splitting), so not command injection; could enable proxy‑based SSRF via the browser. Low.

## 5. Verified clean / positives

- No SQL injection: migrations use static DDL; `import-data` uses parameterized `$1..$n`; no string‑built queries with user input.
- No `eval`/`new Function`/`child_process`/shell exec anywhere in `src/`. Puppeteer args are passed as an array (no shell).
- Global `ApiKeyGuard` + `ThrottlerGuard`; strict `ValidationPipe`; Helmet CSP/HSTS; production error‑message suppression.
- WebSocket handshake is authenticated.
- Dev compose binds API/dashboard to `127.0.0.1` only.

---

## 6. Remediation status

Fixed on branch `security-audit-fixes` (not pushed; `main` untouched): **C‑1, H‑1, H‑2, H‑3, M‑1, M‑2, M‑4, L‑1**, plus an opt‑in webhook SSRF guard (M‑3, default off). Build is clean (`nest build`) and fixes were re‑verified on a live instance. Flagged for maintainer (change‑control gates): **M‑5** (dependency upgrades), Docker/compose `NODE_ENV`/defaults.
