# 09 - Testing Strategy

## 09.1 Current Status

OpenWA now has an active Jest test suite covering the backend core, engine adapters, security helpers,
database migrations, plugin hooks, and smoke-level e2e boot paths. This document describes the current
test layout and the expected testing workflow for contributors.

Status snapshot from the repository state on 2026-06-28:

| Area | Current state |
|------|---------------|
| Backend unit tests | 113 Jest suites / 1481 tests passing with `npm test -- --runInBand` |
| E2E smoke tests | 5 Jest suites / 31 tests passing plus 3 todo with `npm run test:e2e -- --runInBand` |
| Dashboard checks | Dashboard lint, unit tests, i18n parity check, and build |
| Coverage baseline | 66.87% line coverage; active target is 80% (see `docs/superpowers/specs/2025-01-28-test-coverage-improvement-design.md`) |
| Coverage gate | Jest global thresholds plus stricter thresholds for security-sensitive modules |

The exact counts will change as the project evolves. Use the commands below as the source of truth.

```bash
find src test -name '*.spec.ts' -o -name '*.e2e-spec.ts' | wc -l
npm test -- --runInBand
npm run test:e2e -- --runInBand
npm --prefix dashboard run test:unit
```

## 09.2 Test Commands

| Command | Purpose |
|---------|---------|
| `npm test` | Run backend Jest unit tests from `src/` |
| `npm test -- --runInBand` | Run backend tests serially; useful for local debugging and clean output |
| `npm run test:cov` | Run backend tests with coverage and coverage thresholds |
| `npm run test:e2e` | Run smoke-level e2e tests from `test/` |
| `npm run lint` | Run backend ESLint with type-aware rules |
| `cd dashboard && npm run lint` | Run dashboard ESLint |
| `cd dashboard && npm run test:unit` | Run dashboard pure utility/unit tests |
| `cd dashboard && npm run i18n:check` | Verify dashboard locale key parity |
| `cd dashboard && npm run build` | Type-check and build the dashboard |

## 09.3 Backend Unit Tests

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

## 09.4 E2E Smoke Tests

E2E smoke tests live in `test/` and use `test/jest-e2e.json`.

```text
test/
├── app.e2e-spec.ts
├── baileys-engine.e2e-spec.ts
├── serve-static.e2e-spec.ts
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

## 09.5 Coverage Policy

Coverage thresholds are defined in `package.json` under the Jest configuration. Current policy:

| Scope | Branches | Functions | Lines | Statements |
|-------|----------|-----------|-------|------------|
| Global | 30% | 30% | 33% | 33% |
| `src/common/security/` | 85% | 95% | 90% | 90% |
| `src/modules/auth/` | 30% | 50% | 45% | 45% |

These thresholds are intentionally higher for security-sensitive code. When adding security code,
add focused regression tests instead of relying on broad integration coverage.

## 09.6 CI Checks

CI is defined in `.github/workflows/ci.yml`.

| Job | Checks |
|-----|--------|
| `lint` | `npm audit --audit-level=critical`, backend ESLint, formatting check |
| `test` | backend coverage run, e2e smoke tests, Codecov upload |
| `dashboard` | dashboard install, lint, unit tests, i18n parity, build |
| `build` | backend build after lint/test/dashboard jobs pass |
| `docker` | multi-arch Docker build and push on branch pushes |

Release tags run `.github/workflows/release.yml`, which gates Docker publishing behind tests and build,
and publishes the GitHub Release only after the image build succeeds — so a tag never ends up with
release notes but no matching multi-arch image.

## 09.7 Testing Guidelines

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

## 09.8 Manual Smoke Checks

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

## 09.9 Known Gaps

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
