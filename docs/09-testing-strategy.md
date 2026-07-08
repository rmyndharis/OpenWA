# 09 - Testing Strategy

## 9.1 Current Status

OpenWA now has an active Jest test suite covering the backend core, engine adapters, security helpers,
database migrations, plugin hooks, and smoke-level e2e boot paths. This document describes the current
test layout and the expected testing workflow for contributors.

| Area               | Current state                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| Backend unit tests | 158 source-controlled `*.spec.ts` files under `src/`                                                        |
| E2E smoke tests    | 8 source-controlled `*.e2e-spec.ts` files under `test/`                                                     |
| Dashboard checks   | ESLint, i18n parity, React/Vite build, and 10 source-controlled Node test files                             |
| SDK checks         | Path-filtered JavaScript, Python, PHP, and Java SDK CI with 28 source-controlled SDK test files             |
| PostgreSQL checks  | Dedicated CI job builds migrations and runs `npm run test:pg-smoke` against PostgreSQL 16                   |
| Coverage gate      | Jest global thresholds plus stricter thresholds for security, auth, engine-adapter, and integration modules |

The exact counts will change as the project evolves. Use the commands below as the source of truth for
the test inventory, and use the test commands in the next section for pass/fail status.

```bash
rg --files -g '*.spec.ts' src | wc -l
rg --files -g '*.e2e-spec.ts' test | wc -l
rg --files -g '*.test.ts' dashboard/src | wc -l
rg --files sdk/javascript/test sdk/python/tests sdk/php/tests sdk/java/src/test \
  | rg '(\.test\.ts$|test_.*\.py$|Test\.php$|Test\.java$)' \
  | wc -l
npm test -- --runInBand
npm run test:e2e -- --runInBand
npm --prefix dashboard run test:unit
```

## 9.2 Test Commands

| Command                                                           | Purpose                                                                 |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `npm test`                                                        | Run backend Jest unit tests from `src/`                                 |
| `npm test -- --runInBand`                                         | Run backend tests serially; useful for local debugging and clean output |
| `npm run test:cov`                                                | Run backend tests with coverage and coverage thresholds                 |
| `npm run test:e2e`                                                | Run smoke-level e2e tests from `test/`                                  |
| `npm run test:pg-smoke`                                           | Run the PostgreSQL migration and UUID-default smoke test                |
| `npm run lint`                                                    | Run backend ESLint with type-aware rules                                |
| `npm run check:versions`                                          | Verify documentation and package version consistency                    |
| `cd dashboard && npm run lint`                                    | Run dashboard ESLint                                                    |
| `cd dashboard && npm run test:unit`                               | Run dashboard pure utility/unit tests                                   |
| `cd dashboard && npm run i18n:check`                              | Verify dashboard locale key parity                                      |
| `cd dashboard && npm run build`                                   | Type-check and build the dashboard                                      |
| `cd sdk/javascript && npm test && npm run build && npm run smoke` | Test and package-smoke the JavaScript SDK                               |
| `cd sdk/python && pytest`                                         | Run the Python SDK tests                                                |
| `cd sdk/php && ./vendor/bin/phpunit`                              | Run the PHP SDK tests                                                   |
| `cd sdk/java && mvn -B verify`                                    | Run the Java SDK tests                                                  |

## 9.3 Backend Unit Tests

Backend unit tests live next to the source files they cover:

```text
src/
├── common/
│   ├── security/
│   │   ├── ssrf-guard.ts
│   │   └── ssrf-guard.spec.ts
│   └── storage/
│       ├── storage.service.ts
│       └── storage.service.spec.ts
├── engine/
│   ├── adapters/
│   │   ├── baileys.adapter.ts
│   │   └── baileys.adapter.spec.ts
│   └── identity/
│       ├── wa-id.ts
│       └── wa-id.spec.ts
└── modules/
    ├── session/
    │   ├── session.service.ts
    │   └── session.service.spec.ts
    └── webhook/
        ├── webhook.service.ts
        └── webhook.service.spec.ts
```

### What Unit Tests Should Cover

- Service behavior, validation, and error mapping.
- Engine adapter mapping at the boundary, especially neutral WhatsApp IDs and delivery statuses.
- Security helpers such as SSRF checks, path containment, trusted proxy IP resolution, and secret-file handling.
- Database migrations for SQLite and PostgreSQL where SQL differs.
- Plugin hooks, plugin loading, and capability wrappers.
- Race-prone behavior such as reconnect handling, ack reconciliation, and concurrent reaction updates.

### Unit Test Pattern

Use Nest's testing module when dependency injection behavior matters. For pure functions and small helpers,
prefer direct imports with focused assertions.

```typescript
describe('resolveReconnectConfig', () => {
  it('clamps invalid reconnect settings to safe defaults', () => {
    expect(
      resolveReconnectConfig({
        maxReconnectAttempts: 'not-a-number',
        reconnectBaseDelay: -1,
      }),
    ).toEqual({ maxAttempts: 5, baseDelay: 1000 });
  });
});
```

## 9.4 E2E Smoke Tests

E2E smoke tests live in `test/` and use `test/jest-e2e.json`.

```text
test/
├── app.e2e-spec.ts
├── baileys-engine.e2e-spec.ts
├── ingress-instance-throttle.e2e-spec.ts
├── integration-fabric.e2e-spec.ts
├── integration-instance.e2e-spec.ts
├── mcp-auth.e2e-spec.ts
├── serve-static.e2e-spec.ts
├── webhooks.e2e-spec.ts
├── jest-e2e.json
└── setup-e2e.ts
```

`test/setup-e2e.ts` configures the app for local test boot before `AppModule` is imported:

- `NODE_ENV=test`
- SQLite database
- queue disabled
- auto-start sessions disabled
- schema synchronize enabled for test boot

The e2e suite intentionally avoids requiring a live WhatsApp account. It focuses on application boot,
authentication plumbing, public health endpoints, engine selection paths, and dashboard static serving behavior.

## 9.5 Coverage Policy

Coverage thresholds are defined in `package.json` under the Jest configuration. Treat that file as the
authoritative gate. Current policy:

| Scope                      | Branches | Functions | Lines | Statements |
| -------------------------- | -------- | --------- | ----- | ---------- |
| Global                     | 58%      | 58%       | 66%   | 65%        |
| `src/common/security/`     | 85%      | 95%       | 90%   | 90%        |
| `src/modules/auth/`        | 62%      | 70%       | 72%   | 72%        |
| `src/engine/adapters/`     | 63%      | 63%       | 70%   | 70%        |
| `src/modules/integration/` | 67%      | 68%       | 77%   | 77%        |
| `src/core/hooks/`          | 80%      | 70%       | 82%   | 81%        |
| `src/modules/session/`     | 50%      | 63%       | 74%   | 72%        |
| `src/modules/webhook/`     | 65%      | 83%       | 84%   | 80%        |

The stricter scoped gates protect security-sensitive code and high-risk boundary layers. When adding
security, engine-adapter, or integration-fabric behavior, add focused regression tests instead of relying
on broad integration coverage.

## 9.6 CI Checks

Main CI is defined in `.github/workflows/ci.yml`.

| Job             | Checks                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `lint`          | `npm audit --audit-level=critical`, backend ESLint, formatting check, version consistency check |
| `test`          | backend coverage run, e2e smoke tests, Codecov upload                                           |
| `test-postgres` | real PostgreSQL 16 service, backend build, `npm run test:pg-smoke`                              |
| `dashboard`     | dashboard install, lint, unit tests, i18n parity, build                                         |
| `build`         | backend build after lint/test/dashboard jobs pass                                               |
| `docker`        | multi-arch Docker build and push on branch pushes                                               |

SDK CI is defined in `.github/workflows/sdk-ci.yml` and is path-filtered to SDK sources plus server
contract surfaces that SDKs mirror (`src/**/dto/**` and the engine interface). It runs:

- JavaScript SDK tests, build, and dual CJS/ESM smoke test.
- Python SDK tests with `pytest`.
- PHP SDK tests with PHPUnit.
- Java SDK tests with Maven.

Release tags run `.github/workflows/release.yml`. The release gate verifies the tag matches
`package.json`, checks documented version consistency, runs backend tests with coverage, builds the
backend, and publishes the GitHub Release only after the Docker image has built and pushed successfully.

## 9.7 Testing Guidelines

### Add Tests Near the Risk

For narrow changes, add or update the nearest `*.spec.ts`. For shared behavior, test both the helper and
one representative consumer. For adapter changes, test the adapter boundary shape rather than the external
WhatsApp library itself.

### Mock External Systems

Do not require live WhatsApp, Redis, S3, Docker, or internet access for the default test suite. Use mocks,
temporary directories, or local in-memory objects. Keep live-service tests opt-in and document their
environment variables separately.

### Preserve Engine-Neutral Contracts

Tests that touch WhatsApp IDs should assert the neutral dialect used by application code:

- `<phone>@c.us`
- `<id>@g.us`
- `<lid>@lid`
- `status@broadcast`, `<id>@newsletter`, `<id>@broadcast`

Application-level tests should not assert raw Baileys `@s.whatsapp.net` IDs or whatsapp-web.js internals.

### Test Failure Paths

For services that dispatch asynchronously, include tests for lookup failure, delivery failure, retries,
and swallowed fire-and-forget errors. A callback used with `void` should either catch internally or be
covered by a test proving it cannot leak an unhandled rejection.

### Keep E2E Fast

E2E tests should stay smoke-level unless a change specifically needs a full app boot. Prefer unit tests
for business logic and e2e tests for wiring, guards, global pipes, app boot, and route-level behavior.

## 9.8 Manual Smoke Checks

Use these checks when changing Docker, Chromium, dashboard serving, or session startup behavior.

```bash
npm run build:all
node dist/main
```

```bash
docker compose -f docker-compose.dev.yml up -d --build
curl -f http://localhost:2785/api/health/ready
```

For production-compose changes:

```bash
docker compose up -d --build
docker compose logs -f openwa-api
```

Live WhatsApp checks require an operator-owned account and should not be part of CI:

1. Create a session.
2. Start the session.
3. Scan QR or request a pairing code.
4. Confirm session reaches `ready`.
5. Send a text message to a test chat.
6. Confirm message history, webhook delivery, and WebSocket events.

## 9.9 Known Gaps

- No default CI job exercises a real WhatsApp connection.
- No default CI job exercises real PostgreSQL, Redis, S3/MinIO, or Docker socket proxy integration.
- Performance testing is not automated.
- Dashboard browser/visual UI tests are not currently automated; dashboard pure utility tests run via `npm --prefix dashboard run test:unit`.

These gaps are intentional for the default suite because the project prioritizes deterministic tests that
run without external services. Add opt-in integration jobs only when they are isolated, documented, and do
not make normal contributor workflows brittle.

---

<div align="center">

[← 08 - Development Guidelines](./08-development-guidelines.md) · [Documentation Index](./README.md) · [Next: 10 - DevOps & Infrastructure →](./10-devops-infrastructure.md)

</div>
