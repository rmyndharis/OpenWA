# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Dashboard (simple nginx image) proxied API/WebSocket requests to a `openwa` host that doesn't match the
  backend service name; `dashboard/nginx.conf` now targets `openwa-api` for both `/api/` and `/socket.io/`,
  matching the production compose and `Dockerfile.traefik`. Thanks @Abhishekrajpurohit (#259).
- The container entrypoint now clears stale Chromium `SingletonLock`/`SingletonSocket`/`SingletonCookie` files
  from session profiles on start, so a session can re-launch after an unclean shutdown instead of failing with
  "profile appears to be in use by another Chromium process" (exit Code 21). Thanks @Abhishekrajpurohit (#259).

## [0.2.6] - 2026-06-16

A patch release: stop Chromium from failing to launch on hardened `read_only` containers, and make the
Login language selector legible in dark mode.

### Fixed

- Chromium no longer hard-crashes at launch (`Trace/breakpoint trap` / `chrome_crashpad_handler:
  --database is required`) on hardened `read_only` containers. Chromium resolves its home dir from the
  passwd entry and ignores `$HOME`, so the home-less `openwa` user pointed it at a nonexistent
  `/home/openwa`. It is now given writable, pre-created `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` dirs (created
  by the entrypoint, owned by `openwa`). This supersedes the ineffective `--crash-dumps-dir` approach
  from 0.2.5, which is a confirmed no-op for the crashpad database on Debian/Ubuntu system Chromium. (#254)
- The Login screen's language `<select>` option popup is now legible in dark mode. The login route never
  sets `data-theme`, so it relied solely on the `prefers-color-scheme` media block, which set dark colors
  but left `color-scheme` ambiguous — rendering the native popup light with light text. (#249)

## [0.2.5] - 2026-06-16

A patch release: pairing-code linking, a Chromium crash-dumps fix, and dark-mode native controls.

### Added

- **Pairing-code linking** — `POST /sessions/:id/pairing-code` returns an 8-character code so a
  session can be linked via WhatsApp's "Link with phone number" instead of scanning the QR (useful
  for single-device / mobile onboarding). The session must be started and not yet authenticated. (#252)

### Fixed

- Chromium is now given an explicit writable `--crash-dumps-dir` so its crashpad handler always
  receives a `--database`, avoiding `chrome_crashpad_handler: --database is required` browser-launch
  failures on some hardened/container hosts. (#254)
- Dashboard native controls (select option popups, scrollbars) now follow the explicit app theme via
  `color-scheme`, instead of only the OS preference. (#249)

## [0.2.4] - 2026-06-16

A patch release: stop LAN dashboard logins from 500-ing, add a pin for the WhatsApp Web version
(works around sessions stuck at "authenticating"), and harden the data-export stream.

### Added

- **Pinnable WhatsApp Web version** via `WWEBJS_WEB_VERSION`. whatsapp-web.js 1.34.x can hang at
  `authenticating` (the post-link sync never completes) when the auto-selected WA-Web version is
  incompatible; set a known-good version (browse
  [wppconnect-team/wa-version](https://github.com/wppconnect-team/wa-version)) to pin it.
  Opt-in — unset keeps the default auto-version behavior. (#251)

### Fixed

- **Dashboard login over LAN no longer returns 500.** A disallowed CORS origin threw inside the
  cors callback, surfacing as an Internal Server Error; it now denies without throwing — so the
  bundled (same-origin) dashboard works on a LAN/remote host out of the box, while a genuine
  cross-origin dashboard still needs its origin in `CORS_ORIGINS`. (#250)
- Data-export stream now surfaces archive-level errors (gzip/finalize) on the response stream
  instead of an unhandled rejection or a silently truncated download. (#248)

## [0.2.3] - 2026-06-15

A patch release: the dashboard now works when served over plain HTTP on a non-`localhost`
origin (LAN/remote), plus a configurable dev-compose bind host.

### Fixed

- **Dashboard now works over plain HTTP on a non-`localhost` origin.** Toast notifications and
  the API-key copy button used secure-context-only browser APIs (`crypto.randomUUID`,
  `navigator.clipboard`) that are unavailable over HTTP on a LAN IP — so creating a session
  threw `crypto.randomUUID is not a function`. Both now degrade gracefully (non-crypto id
  fallback; `execCommand('copy')` clipboard fallback). (#244)
- The Infrastructure page's "View Bull Board" link no longer hardcodes `http://localhost:2785`;
  it opens the configured API origin, so it works on remote/LAN deployments.

### Changed

- The dev compose (`docker-compose.dev.yml`) bind host is now configurable via `BIND_HOST`
  (default `127.0.0.1`); set `BIND_HOST=0.0.0.0` in `.env` to reach the dev stack from another
  host (front it with a TLS proxy for anything public). Thanks @Stanley-blik (#245).

## [0.2.2] - 2026-06-15

A security-hardening and reliability release. It tightens defaults (SSRF protection on,
datastore secrets required, least-privilege webhook reads), closes a server-side
request-forgery vector on media fetches and webhook deliveries, adds an optional Prometheus
metrics endpoint, fixes headless Chromium startup in the non-root Docker image, and refreshes
dependencies. **Please read the Upgrade notes below before upgrading from 0.2.1** — several
defaults changed.

### Added

- **Prometheus metrics** at `GET /api/metrics` (session/message gauges, process stats).
  Disabled by default; set `METRICS_TOKEN` and scrape with `Authorization: Bearer <token>`.

### Security

- **Webhook secrets no longer leak:** the HMAC `secret` and custom `headers` are never
  returned from any webhook API response (responses are mapped through a scoped DTO).
- **Media-fetch SSRF closed:** server-side `MessageMedia.fromUrl` now runs an SSRF host
  guard + byte cap + timeout before fetching a caller-supplied URL.
- **Redirects are not followed** on webhook deliveries or media fetches, so a `302` to an
  internal host can't bypass the SSRF guard.
- **Webhook SSRF protection is ON by default** and validated at registration.
- **Docker hardening:** the socket-proxy is isolated on an `internal: true` network reachable
  only by the API (not the dashboard); the API container runs with `cap_drop: [ALL]` (+ a
  minimal re-add), `no-new-privileges`, a `read_only` rootfs + tmpfs, and pid/mem limits.
- **Plugin loader** rejects a manifest `main` that escapes the plugin directory before
  `require()`.
- **WebSocket:** the API key is re-validated on every subscribe (a revoked key is
  disconnected), is no longer sent in the handshake URL, and CORS uses the configured
  allowlist instead of `*`.
- **Production boot guard:** the app refuses to start in production with empty/placeholder
  secrets, and the committed default datastore credentials were removed.
- **Rate limiting** now keys on the resolved client IP instead of the proxy IP.

### Changed

- Webhook read routes now require an `OPERATOR`+ key.
- Webhook `events[]` are validated against the known event types (plus `*`).
- The six inline-body message endpoints (+ label/channel) now validate their input.
- The `main` auth/audit DB `synchronize` is config-driven (`MAIN_DATABASE_SYNCHRONIZE`,
  default on) with a bundled migration for `api_keys`/`audit_logs`.
- The readiness probe (`/api/health/ready`) now performs real database checks and returns
  503 when a dependency is down or the app is draining; the container `HEALTHCHECK` points
  at it.

### Fixed

- Message ack status UPDATE is scoped by `sessionId` (no cross-session corruption) and
  backed by a composite index.
- `getMessages` sanitizes `limit`/`offset` so `?limit=abc` no longer reaches the query.
- The Postgres database name now honors `DATABASE_NAME` consistently between the runtime and
  the migration CLI.
- Backup/restore scripts (`scripts/backup.sh`/`restore.sh`) capture **both** databases
  (incl. the auth DB `main.sqlite`) + sessions, so a restore preserves API keys.
- Boot-time environment validation rejects an unknown `DATABASE_TYPE` and missing Postgres
  credentials instead of silently coercing.
- Message-event idempotency keys are session-scoped.
- Response-envelope documentation corrected to the real raw-payload shape; the unused
  interceptor/filter were removed; horizontal-scaling docs marked single-instance.
- **Headless Chromium now starts in the Docker image as the non-root `openwa` user** — `HOME`
  points at a writable directory, so the engine no longer dies with
  `chrome_crashpad_handler: --database is required` on a fresh container. (closes #242)
- Marking a 1:1 chat as read now accepts the newer `@lid` (privacy Linked ID) JID, not just
  `@c.us`. Thanks @suraj7974 (#241).
- Allowlisted IPv6 literals in `SSRF_ALLOWED_HOSTS` now match whether or not the entry is
  bracketed (e.g. `[::1]` and `::1`).
- The dashboard returns cleanly to the login screen on a `401` instead of flashing a transient
  error toast.
- A webhook `secret` cleared via update is normalized to "no secret" (consistent with create)
  and is length-capped.

### Dependencies

- `@bull-board/{api,nestjs,express}` 7.2.1 → 8.0.0 and `@types/archiver` 7 → 8 (aligned with the
  archiver v8 runtime), plus a batch of minor/patch bumps (NestJS 11.1.27, BullMQ 5.78.1, AWS SDK,
  ESLint 10.5, Prettier 3.8, typescript-eslint 8.61, and a dashboard dev-tool bump).

### Upgrade notes (behavior changes)

- **Webhook reads now require `OPERATOR`+** — a `VIEWER` key reading webhooks gets `403`.
- **SSRF protection defaults ON** — deployments that deliver webhooks or fetch media from
  internal hosts must set `SSRF_ALLOWED_HOSTS` (comma-separated) or `WEBHOOK_SSRF_PROTECT=false`.
- **Datastore secrets are now required** — there is no `openwa`/`minioadmin` default;
  `docker compose --profile postgres/minio up` needs `DATABASE_PASSWORD` / `S3_*` set, and
  production refuses to boot with placeholder secrets.
- **Bull Board `?apiKey=` removed** — authenticate via `X-API-Key`/`Authorization: Bearer`.
- New env knobs: `SSRF_ALLOWED_HOSTS`, `MEDIA_DOWNLOAD_MAX_BYTES`, `MEDIA_DOWNLOAD_TIMEOUT_MS`,
  `MAIN_DATABASE_SYNCHRONIZE`, `SHUTDOWN_DELAY_MS`, `OPENWA_MEM_LIMIT`, `METRICS_TOKEN`.

## [0.2.1] - 2026-06-15

A patch release.

### Fixed

- **Dashboard:** The API client now honors `VITE_API_URL` for split-origin deployments.
  It reads `VITE_API_URL` (the API origin) and appends `/api` instead of always calling the
  same-origin `/api`; the same-origin default is unchanged. This fixes the dashboard
  failing with "Invalid API Key" when it is hosted on a different origin than the API.
  Thanks @jairo315-bit (#91).

### Dependencies

- **Dashboard:** Bump the TypeScript dev dependency from 5.9.3 to 6.0.3 (#140).

## [0.2.0] - 2026-06-15

A major feature- and security-focused release. Adds six dashboard languages and a
real-time Chats view, completes the outgoing-message and delivery-state webhook
story, introduces message templates and live chat history, hardens the API surface,
session lifecycle, and container runtime, and upgrades the WhatsApp engine. See
**Upgrade notes** for the behavior changes.

### Added

- **Dashboard / Chats:** A new real-time Chats view — browse a session's
  conversations, stream incoming and outgoing messages live over WebSocket, send
  text and media, and mark chats as read. Thanks @akbarxleqi (#152).
- **Dashboard / i18n:** Six new languages on a single canonical language picker —
  Simplified Chinese, Traditional Chinese, Arabic (full RTL), Telugu, French, and
  Italian — alongside the existing English and Hebrew. The picker now also appears
  on the Login screen and resolves `zh-Hant/HK/MO/TW` regional variants. Thanks
  @jr-everstar (#150), @7odaifa-ab (#145), @abhinayguduri (#149), and
  @albanobattistella (#224).
- **Messages:** Server-side **message templates** with `{{variable}}` substitution —
  full CRUD under `/sessions/:id/templates` plus a
  `POST /sessions/:id/messages/send-template` endpoint that renders and sends.
  Text templates only; interactive buttons/list/HSM are not supported on the
  whatsapp-web.js engine. Thanks @esakarya (#69).
- **Messages:** `GET /sessions/:id/messages/:chatId/history` reads chat history live
  from WhatsApp (bypassing the local DB), with optional base64 media; `limit` is
  clamped to 1–100. Thanks @jgalea (#96, closes #162).
- **Groups:** Group payloads now expose `linkedParentJID` — the JID of the parent
  community a sub-group belongs to. Thanks @ferhatte10 (#201).
- **Webhooks:** `message.sent` now fires for **every** outgoing message — including
  messages composed on a linked phone (via the whatsapp-web.js `message_create`
  event), not just messages sent through the API. (closes #93, #168, #195)
- **Webhooks / Sessions:** Stored message status now reflects real delivery state
  from acks — `delivered`, `read`, and `failed` — advancing monotonically (a late
  or out-of-order ack can never downgrade a higher status). A send that never
  receives a delivery ack stays `sent`, so it is visibly "not delivered" instead of
  falsely "sent". A new `message.failed` webhook is emitted on an error ack so
  consumers can detect non-delivery without polling. Independently identified and
  prototyped by @aminebalti55 (#225). (closes #155, #199, #220)
- **Webhooks:** Opt-in outbound SSRF protection — set `WEBHOOK_SSRF_PROTECT=true` to
  refuse webhook URLs that resolve to loopback, private, link-local, CGNAT, or
  cloud-metadata addresses (default off). (#221)
- **API:** `BODY_SIZE_LIMIT` caps request body size (default 25 MB, sized for
  base64 media sends). `ENABLE_SWAGGER` gates the `/api/docs` UI (default on; set
  `false` to disable it on exposed deployments). (#221, #67)
- **Webhooks:** `message.received` payloads now include the group sender's identity
  — `author` (the participant WID) and `contact` `{ name, pushName }`. Additive and
  backward compatible. (#223, closes #146)
- **Sessions:** Opt-in auto-start of previously authenticated sessions on boot via
  `AUTO_START_SESSIONS=true` (default off); sessions start sequentially to bound
  Puppeteer memory and one failure does not block the others. Thanks @mayko7d
  (#135, closes #218).
- **Sessions:** `PUPPETEER_EXECUTABLE_PATH` points the engine at a system
  Chromium/Chrome binary (for Alpine, ARM, or custom base images); unset keeps
  Puppeteer's bundled Chromium. (#219)
- **Docs:** Community integrations page documenting the community-maintained
  ioBroker adapter (with a not-endorsed caveat). (#223, closes #134)

### Changed

- **Engine:** Upgraded `whatsapp-web.js` from 1.26.1-alpha.3 to **1.34.7**
  (improved LID handling and stability). (#222)
- **Dashboard:** Responsive layout for small screens and improved dark-mode
  contrast across pages; the Plugins page no longer truncates the feature list.
  Thanks @ashiwanikumar (#66).
- **Auth:** The first-boot admin key is now a cryptographically random `owa_k1_`
  key in **all** environments by default; the fixed `dev-admin-key` is seeded only
  when `ALLOW_DEV_API_KEY=true` is explicitly set. (#221)
- **Auth:** Requests with a valid key but insufficient role now return **403
  Forbidden** instead of 401. (#221)
- **Docker / Podman:** Base images are fully qualified (`docker.io/node:22-slim`)
  and the container healthcheck uses `curl`, so the image builds and runs under
  Podman as well as Docker; added a Podman compatibility note to the docs. Thanks
  @3bsalam-1 (#68).
- **Docs / API:** Interactive messages (`Buttons` / `List`) are documented as
  unsupported on the whatsapp-web.js engine, and the speculative request-body
  examples were removed from the API collection. (#223, closes #158)

### Fixed

- **Sessions:** An engine operation attempted while a session is disconnected,
  reconnecting, or still initializing (for example, refreshing the dashboard after
  disconnecting the session from the phone) now returns **409 Conflict**
  ("session not connected") instead of a 500 Internal Server Error. Thanks
  @VincenzoKoestler for the related report. (#100)
- **Sessions:** A terminal engine failure (Chromium failed to launch, or WhatsApp
  rejected the stored credentials) now surfaces as a `failed` status with a
  human-readable reason on the session and in the dashboard, instead of silently
  closing the QR modal; `auth_failure` is treated as terminal rather than
  triggering a reconnect loop. A status race that could revert `qr_ready` back to
  `initializing` during startup is also fixed. (#219)
- **Engine:** The built-in engine plugin now honors `SESSION_DATA_PATH` and the
  configured Puppeteer settings instead of silently falling back to relative-path
  defaults. (#219)
- **Infrastructure dashboard:** Saved configuration (`data/.env.generated`) now
  applies reliably. The save handler wrote several env names the backend never read
  (`STORAGE_PATH`, `S3_ACCESS_KEY` / `S3_SECRET_KEY`, `ENGINE_HEADLESS` /
  `ENGINE_SESSION_PATH` / `ENGINE_BROWSER_ARGS`), so those settings silently reverted
  to defaults on restart; they now match what `configuration.ts` reads. Saving also
  merges into the existing file instead of rewriting it from scratch, so a partial
  save no longer blanks other keys or stored secrets, and the form hydrates from a
  new `GET /infra/config` endpoint. Thanks @VincenzoKoestler (#226).

### Security

- **CORS:** A wildcard (`*`) origin is now **refused in production** (cross-origin
  requests are blocked), and CORS credentials are only enabled with an explicit
  origin allowlist. (#221)
- **WebSocket:** A session-scoped API key can no longer subscribe to `*` or to
  sessions outside its `allowedSessions` allowlist, preventing cross-tenant event
  leakage. (#221)
- **Authorization:** Plugin enable/disable/config and the infrastructure read
  endpoints (`/infra/status`, `/infra/config`, `/engines`, `/engines/current`,
  `/storage/files/count`) now require an **ADMIN** key. (#221, #226)
- **Docker:** The container reaches the Docker API through a least-privilege
  `docker-socket-proxy` over TCP (`DOCKER_HOST`) instead of mounting the socket
  directly, and the Node process runs as a non-root `openwa` user via a `gosu`
  privilege-dropping entrypoint (`dumb-init` stays PID 1 for clean signal handling).
  Thanks @A831ARD0 (#227, #228; supersedes #129).
- **Health:** `/api/health` is excluded from rate limiting so liveness probes do
  not exhaust the limiter. (#221)

### Dependencies

- **CI:** Upgraded `softprops/action-gh-release` v2→v3 and
  `docker/build-push-action` v6→v7 (both move the GitHub Actions runtime to
  Node 24). (#169, #170)

### Upgrade notes

- **CORS in production:** if you serve the dashboard on a different origin than the
  API and relied on the default `CORS_ORIGINS=*`, set `CORS_ORIGINS` to the explicit
  dashboard origin(s) — a wildcard is now refused in production.
- **Infrastructure reads are ADMIN-only:** `/api/infra/status`, `/infra/config`,
  `/engines`, `/engines/current`, and `/storage/files/count` now require an ADMIN key.
- **Role-denied requests return 403** (was 401) — update clients that branch on the
  status code.
- **Not-ready engine ops return 409** (was 500) — clients calling group/chat/send
  endpoints while a session is not connected now receive `409 SESSION_NOT_READY`.
- **First-boot key:** non-production no longer seeds `dev-admin-key` by default (a
  random key is generated and printed in the startup banner / written to
  `data/.api-key`). Set `ALLOW_DEV_API_KEY=true` to restore the fixed local key.
- **Docker:** the bundled Compose now runs a `docker-proxy` sibling and the API
  talks to it via `DOCKER_HOST`, and the container runs as non-root; review the new
  Compose if you mounted the Docker socket directly or customized orchestration.

## [0.1.8] - 2026-06-13

A bug-fix patch release for self-hosted PostgreSQL (TLS/SSL) deployments and
webhook delivery deduplication. Backward compatible; defaults are unchanged.

### Added

- **Dashboard / Setup:** The Infrastructure screen now exposes a **Verify SSL Certificate** toggle (`DATABASE_SSL_REJECT_UNAUTHORIZED`), shown when SSL is enabled, so managed-Postgres TLS can be configured end-to-end from the UI without hand-editing `.env`. Defaults to verifying certificates; turn it off only for managed Postgres with self-signed certs (Supabase, Heroku, Render, Railway).

### Fixed

- **Database:** The runtime PostgreSQL TypeORM connection now honors `DATABASE_SSL` and `DATABASE_SSL_REJECT_UNAUTHORIZED`. Previously SSL was wired only into the migration CLI, so `DATABASE_SSL=true` was silently ignored on the live connection. Defaults are unchanged (`ssl: false`), so existing deployments are unaffected. Thanks @farrasyakila (#205, closes #204).
- **Webhooks:** Fixed idempotency-key generation for `message.received`, `message.sent`, `message.ack`, and `message.revoked`. The dispatched payload is an `IncomingMessage` carrying `id` (not `messageId`), but the resolver short-circuited on a truthy `'unknown'` fallback and never read `id`, so every incoming-message webhook was keyed `msg_unknown` — collapsing all messages into one deduplication bucket for consumers relying on the `X-OpenWA-Idempotency-Key` header. The resolver now uses `id ?? messageId`, with regression tests for the id-only and both-present payload shapes. Thanks @Singh1106 (#179).
- **Dashboard:** The Login screen now derives the displayed version from `package.json` at build time instead of a hard-coded literal, so it always reflects the installed release rather than a stale placeholder (closes #88).

## [0.1.7] - 2026-06-13

A security- and stability-focused patch release. Hardens the API surface,
clears a critical dependency advisory, and resolves a batch of self-hosting
bugs. Backward compatible except for the two upgrade notes below.

### Security

- **Path traversal in storage import**: `StorageService` extracted tar archive
  entries (and read/wrote files) using unvalidated paths, allowing writes
  outside the storage root. Added a path-containment check on local read/write.
  Fixes #151. (#207)
- **Broken access control on infrastructure endpoints**: every `/api/infra/*`
  mutating and data-exfiltration endpoint (config, restart, export-data,
  import-data, storage/export, storage/import) required only any valid API key.
  They now require the **ADMIN** role. (#207)
- **X-Forwarded-For IP spoofing**: `ApiKeyGuard` trusted the client-controllable
  `X-Forwarded-For` header for the per-key `allowedIps` whitelist. It now ignores
  it by default and only honours it for configured `TRUSTED_PROXIES`. (#211)
- **Fail-closed IP whitelist**: a key with an `allowedIps` whitelist but an
  undetermined client IP previously skipped the check (failed open); it now
  rejects. The QR endpoint (`GET /sessions/:id/qr`) now requires `OPERATOR`. (#213)
- **Bull Board queue UI** (`/api/admin/queues`) was reachable unauthenticated;
  it now requires an ADMIN API key. (#214)
- **Critical dependency advisory**: bumped `concurrently` to v10 to clear the
  critical `shell-quote` advisories. (#208)

### Fixed

- **Swagger UI** now sends the `X-API-Key` header (global security scheme). Fixes #173. (#109)
- **Dashboard Docker build** failed on the Vite 8 / `@vitejs/plugin-react` v5 peer
  conflict; upgraded the plugin to v6. Fixes #103, #123, #197. (#136)
- **Bulk send** (`/messages/send-bulk`) returned 400 for text-only messages
  (missing `@IsOptional()` on media fields). Fixes #192. (#193)
- **Group participant endpoints** returned 400 because their DTOs lacked
  `class-validator` decorators. Fixes #190. (#210)
- **Cross-platform `postinstall`**: replaced POSIX-only shell syntax that broke
  `npm install` on Windows. Fixes #181. (#209)
- Controllers now throw proper NestJS HTTP exceptions instead of generic `Error`
  (correct 400/404 instead of 500). (#102)
- Dashboard QR modal shows a loading state and keeps polling until ready. (#97)
- Traefik dashboard image now proxies `/api` and `/socket.io`. Fixes #116. (#131)
- Wired the documented `API_MASTER_KEY` env var into the initial key seed. Fixes #153. (#133)
- Fixed the `Location` constructor ESM/CJS interop in the whatsapp-web.js adapter. (#186)
- Incoming webhook messages now include location data for location messages. (#202)

### Changed

- **Lint is now enforced**: `lint` runs ESLint in check mode (fails on
  violations) with a new `lint:fix` for local auto-fixing; fixed the latent
  lint issues this surfaced across the codebase. (#208)
- **CI** publishes multi-arch Docker images (`linux/amd64` + `linux/arm64`).
  Closes #164. (#166)

### Added

- Documented the API key management endpoints. Closes #110. (#130)
- Indonesian Docker deployment guide and an API-spec diagram fix. (#188, #189)

### Dependencies

- Dependabot minor/patch group (NestJS, BullMQ, Bull Board, helmet, ioredis,
  etc.) and `@types/uuid` v11. (#194, #143)

### Upgrade notes

- **Infrastructure endpoints are now ADMIN-only.** Integrations calling
  `/api/infra/config|restart|export-data|import-data|storage/*` with a
  non-admin key will now receive an auth error; use an ADMIN key.
- **Reverse-proxy + per-key `allowedIps`**: if you run behind Traefik/nginx and
  restrict keys by IP, set `TRUSTED_PROXIES` (e.g. `TRUSTED_PROXIES=172.18.0.0/16`)
  so the real client IP is resolved; otherwise `X-Forwarded-For` is ignored.

## [0.1.6] - 2026-05-17

### Fixed

- **PostgreSQL migration crash**: `AddMessageStatus1770108659848` migration contained hardcoded
  SQLite-specific raw SQL (`datetime` type, `datetime('now')` function) that PostgreSQL doesn't
  recognize. Migration now detects database type at runtime and uses appropriate SQL syntax.
  SQLite path is byte-for-byte identical to the original (zero regression). PostgreSQL path uses
  `timestamp` / `NOW()` / `DEFAULT true` / inline FK constraints. Fixes #59, #62.

### Changed

- **Version badge sync**: Updated version badges in `README.md` (was 0.1.4), `docs/README.md`
  (was 0.1.0), and Swagger API docs (was 0.1.0) to 0.1.6.
- **Dependency updates**: Merged Dependabot PRs for 12 npm packages (`@aws-sdk/client-s3`,
  `@nestjs/swagger`, `bullmq`, `class-validator`, `tar-stream`, `typeorm`, `@types/node`,
  `eslint`, `globals`, `jest`, `typescript-eslint`) and 1 dashboard package (`globals`).
- **GitHub Actions**: Upgraded `docker/setup-buildx-action` v3→v4, `codecov/codecov-action` v5→v6,
  `docker/login-action` v3→v4, `docker/metadata-action` v5→v6, `actions/upload-artifact` v6→v7.

## [0.1.5] - 2026-04-27

### Fixed

- **First-boot crash on SQLite**: Data DB now defaults to `synchronize=true` for SQLite so the embedded
  database "just works" on first boot. Resolves `SQLITE_ERROR: no such table: sessions` that appeared on
  fresh installs without `DATABASE_SYNCHRONIZE=true`.
- **PostgreSQL boot crash on `main` connection**: `AuditLog.metadata` now uses `simple-json` instead of
  the dynamic `jsonColumnType()`. The `main` connection is always SQLite, so it must not switch to
  `jsonb` when `DATABASE_TYPE=postgres`. Fixes `DataTypeNotSupportedError: Data type "jsonb" in
"AuditLog.metadata" is not supported by "sqlite" database`.
- **Operator env vars ignored**: `data/.env.generated` no longer overrides `process.env` or project
  `.env`. Loading order is now `process env > .env > data/.env.generated`, so values from Docker /
  shell / systemd take precedence over Dashboard-saved config.

### Changed

- **Auto-run migrations on boot**: PostgreSQL data DB now runs pending migrations automatically; SQLite
  also runs migrations when the user opts out of `synchronize`.
- **Production migration scripts**: Added `migration:run:prod`, `migration:revert:prod`, and
  `migration:show:prod` that operate from `dist/` so they can be executed inside the production
  container (which strips `ts-node`).

## [0.1.4] - 2026-02-26

### Changed

- **ESLint 10 upgrade**: Upgraded `eslint` and `@eslint/js` from v9 to v10 in both root and dashboard
- **Dependency updates**: Merged Dependabot PRs for 6 root packages, 2 dashboard packages, and `@types/node` 24→25
- **Dashboard peer deps**: Added `.npmrc` with `legacy-peer-deps=true` for `eslint-plugin-react-hooks` ESLint 10 compatibility

### Fixed

- **Dashboard lint**: Fixed `no-useless-assignment` error in `Infrastructure.tsx` caught by ESLint 10's new rule
- **Auto-formatting**: Applied Prettier fix to `whatsapp-web-js.types.ts`

## [0.1.3] - 2026-02-18

### Fixed

- **Node 22 LTS upgrade**: Upgraded CI, release workflow, and Dockerfile from Node 20 to Node 22 (current LTS)
- **Lockfile compatibility**: Regenerated `package-lock.json` with npm 10 to match CI runtime
- **TypeScript type conflicts**: Fixed `whatsapp-web.js` type mismatches after dependency update using `Omit<>` pattern
- **ESLint peer dependency**: Pinned `@eslint/js` and `eslint` to v9 to resolve Dependabot-introduced peer conflict
- **CI npm audit**: Changed audit level from `high` to `critical` — high-severity findings are all in unfixable transitive dependencies

### Changed

- **Dependency updates**: Merged Dependabot PRs for 12 npm packages, 6 dashboard packages, and 5 GitHub Actions
- **GitHub Actions**: Upgraded `actions/checkout` v4→v6, `actions/setup-node` v4→v6, `actions/upload-artifact` v4→v6, `docker/build-push-action` v5→v6, `codecov/codecov-action` v4→v5

## [0.1.2] - 2026-02-18

### Fixed

- **[P1] Database safety**: Default `DATABASE_SYNCHRONIZE` to false to prevent auto-schema changes in production
- **[P1] Graceful shutdown**: Replace `process.exit()` with ShutdownService callback pattern
- **[P1] PostgreSQL types**: Use native `jsonb` and `timestamp` column types when available
- **[P1] Docker orchestration**: Remove duplicate Docker management from main.ts (use DockerService)
- **[P1] Queue stub**: Remove unimplemented message queue processor that always threw errors
- **[P2] Error visibility**: Add proper logging to all 12 empty catch blocks across backend services
- **[P2] Type safety**: Reduce `any` usage from 38 to ~4 with typed interfaces for whatsapp-web.js
- **[P2] Data consistency**: Add TypeORM transaction support for session CRUD; save-before-send pattern for messages
- **[P2] Dashboard crashes**: Add ErrorBoundary with fallback UI instead of white screen of death
- **[P2] Dashboard security**: Move API key from localStorage to sessionStorage (cleared on browser close)
- **[P2] Dashboard UX**: Replace blocking `alert()` calls with Toast notifications
- **[P2] Dashboard error handling**: Add logging to all empty catch blocks in dashboard pages

### Changed

- **Dashboard React Query**: Migrate all 8 pages from manual `useState`/`useEffect` to `@tanstack/react-query` with automatic caching and deduplication
- **Dashboard code splitting**: Route-level lazy loading with `React.lazy` + `Suspense` — main bundle reduced 36%

### Added

- **CI npm audit**: `npm audit --audit-level=high` in CI pipeline to catch vulnerabilities
- **CI coverage threshold**: Jest coverage floor to prevent regression
- **CI dashboard job**: Lint + build for React dashboard runs parallel with backend CI
- **Dependabot**: Automated dependency updates — npm weekly, GitHub Actions monthly

## [0.1.1] - 2026-02-17

### Added

- **Unit Tests**: 94 new tests across auth, session, message, and webhook modules (110 total, ~17% coverage)
- **Release Workflow**: `release.yml` GitHub Actions — tag-triggered with test gate, GitHub Release, and Docker semver tagging
- **SDK Scaffolds**: JavaScript/TypeScript and Python client libraries in `sdk/` directory
- New hook events: `webhook:queued` (after queue add) and `webhook:delivered` (after actual delivery)

### Fixed

- **[P1] Idempotency Key**: Made `generateIdempotencyKey` deterministic by removing `Date.now()`. Keys are now content-based for proper deduplication
- **[P2] Webhook Processor**: Added `lastTriggeredAt` update and `webhook:delivered`/`webhook:error` hooks after queue delivery
- **[P2] Hook Semantics**: Added `webhook:queued` event for queue mode; `webhook:after` now only fires in direct mode
- **[P2] QueueModule DI**: Added `TypeOrmModule.forFeature([Webhook])` and `HooksModule` imports for proper dependency injection
- **[P3] Message Processor**: Changed placeholder to throw error so BullMQ correctly marks job as failed

## [0.1.0] - 2026-02-05

### 🎉 Initial Release

OpenWA v0.1.0 is the first stable release featuring a complete WhatsApp API Gateway with all core functionality.

### Core Features

- **REST API** for WhatsApp operations
- **Multi-session** support with concurrent session handling
- **Web Dashboard** for visual management
- **WebSocket** real-time events via Socket.IO
- **API Key Authentication** with role-based permissions
- **Webhook System** with HMAC signatures and queue-based retries

### Messaging

- Send/receive text, image, video, audio, document messages
- Message reactions and replies
- Bulk messaging with rate limiting
- Location and contact sharing
- Sticker support

### Advanced Features

- **Groups API** - Full CRUD operations
- **Channels/Newsletter** support
- **Labels Management**
- **Catalog API** for product management
- **Status/Stories** support
- **Proxy per Session** configuration
- **Plugin System** for extensibility

### Infrastructure

- SQLite (development) and PostgreSQL (production) support
- Redis queue for webhook delivery (optional)
- S3/MinIO storage for media (optional)
- Docker + Docker Compose deployment
- Traefik reverse proxy integration
- Health check endpoints
- Zero-config onboarding with auto-generated API key

### Security

- API key authentication with SHA-256 hashing
- Rate limiting (configurable)
- CIDR IP whitelisting
- CORS configuration
- Helmet security headers
- Audit logging for all operations

### Dashboard

- Session management with QR code display
- Webhook configuration and testing
- API key management
- Message tester for debugging
- Infrastructure status monitoring
- Audit logs viewer
- Plugin management
