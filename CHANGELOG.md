# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
