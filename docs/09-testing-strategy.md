# 09 - Testing Strategy

## 9.1 Current Status

OpenWA now has an active Jest test suite covering the backend core, engine adapters, security helpers,
database migrations, plugin hooks, and smoke-level e2e boot paths. This document describes the current
test layout and the expected testing workflow for contributors.

| Area               | Current state                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| Backend unit tests | Source-controlled `*.spec.ts` files under `src/`; use the inventory commands below                          |
| E2E smoke tests    | Source-controlled `*.e2e-spec.ts` files under `test/`; use the inventory commands below                     |
| Dashboard checks   | ESLint, test type-check, i18n parity, React/Vite build, and source-controlled Node tests                    |
| SDK checks         | Path-filtered JavaScript, Python, PHP, Java, and Go SDK CI                                                  |
| PostgreSQL checks  | Dedicated CI job builds migrations and runs `npm run test:pg-smoke` against PostgreSQL 16                   |
| Coverage gate      | Jest global thresholds plus stricter thresholds for security, auth, engine-adapter, and integration modules |

The exact counts will change as the project evolves. Use the commands below as the source of truth for
the test inventory, and use the test commands in the next section for pass/fail status.

```bash
rg --files -g '*.spec.ts' src | wc -l
rg --files -g '*.e2e-spec.ts' test | wc -l
rg --files -g '*.test.ts' dashboard/src | wc -l
rg --files sdk/javascript/test sdk/python/tests sdk/php/tests sdk/java/src/test sdk/go \
  | rg '(\.test\.ts$|test_.*\.py$|Test\.php$|Test\.java$|_test\.go$)' \
  | wc -l
npm test -- --runInBand
npm run test:e2e -- --runInBand
npm --prefix dashboard run test:unit
```

## 9.2 Test Commands

| Command                                                          | Purpose                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `npm test`                                                       | Run backend Jest unit tests from `src/`                                  |
| `npm test -- --runInBand`                                        | Run backend tests serially; useful for local debugging and clean output  |
| `npm run test:cov`                                               | Run backend tests with coverage and coverage thresholds                  |
| `npm run test:e2e`                                               | Run smoke-level e2e tests from `test/`                                   |
| `npm run test:pg-smoke`                                          | Run the PostgreSQL migration and UUID-default smoke test                 |
| `npm run test:scripts`                                           | Run the repo-level script tests on the Node test runner                  |
| `./scripts/smoke-test-backup-restore.sh`                         | Run the backup/restore smoke test used by the `scripts-smoke` job        |
| `npm run lint`                                                   | Run backend ESLint with type-aware rules                                 |
| `npm run format:check`                                           | Check Prettier formatting for backend source and specs                   |
| `npx tsc --noEmit -p tsconfig.json`                              | Type-check backend source, unit specs, and e2e specs                     |
| `npm run openapi:check`                                          | Verify the committed OpenAPI snapshot                                    |
| `npm run check:versions`                                         | Verify documentation and package version consistency                     |
| `npm run check:dockerignore`                                     | Verify the Docker build context that `.dockerignore` defines             |
| `cd dashboard && npm run lint`                                   | Run dashboard ESLint                                                     |
| `cd dashboard && npm run typecheck`                              | Type-check dashboard test files                                          |
| `cd dashboard && npm run test:unit`                              | Run dashboard pure utility/unit tests                                    |
| `cd dashboard && npm run i18n:check`                             | Verify dashboard locale key parity                                       |
| `cd dashboard && npm run build`                                  | Type-check and build the dashboard                                       |
| `cd sdk/javascript && npm test && npm run typecheck`             | Type-check and unit-test the JavaScript SDK                              |
| `cd sdk/javascript && npm run build && npm run smoke`            | Build and dual CJS/ESM package-smoke the JavaScript SDK                  |
| `cd sdk/python && pytest`                                        | Run the Python SDK tests                                                 |
| `cd sdk/php && ./vendor/bin/phpunit`                             | Run the PHP SDK tests                                                    |
| `cd sdk/java && mvn -B verify`                                   | Run the Java SDK tests                                                   |
| `cd sdk/go && gofmt -l . && go vet ./... && go test -race ./...` | List unformatted files, vet, and race-test the Go SDK                    |
| `npm run test:scripts`                                           | Run the install-script tests (`node --test scripts/postinstall.spec.js`) |
| `npm run check:dockerignore`                                     | Verify `.dockerignore` still excludes what the image must not carry      |
| `npm run check:versions`                                         | Verify docs and Swagger track the `package.json` version                 |

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
      // non-numeric attempts → the default: unlimited retries (backoff parks at the 1h cap);
      // negative baseDelay → clamped up to the 1s minimum
    ).toEqual({ maxAttempts: Number.POSITIVE_INFINITY, baseDelay: 1000 });
  });
});
```

## 9.4 E2E Smoke Tests

E2E smoke tests live in `test/` and use `test/jest-e2e.json`.

> **They run one at a time (`maxWorkers: 1`), and that is a correctness requirement, not a
> performance preference.** Each suite boots a real application, and not every piece of application
> state is redirected to a per-worker location. `dataDir` is a hard-coded `./data` with no
> environment lever, so every worker's plugin loader read-modify-writes the same
> `data/plugins/registry.json`. Measured on a single parallel run: 52 writes from 12 processes, 30
> of them within 500ms of a write by a different process. Individual writes are atomic; the
> read-modify-write cycle is not.
>
> Running them in parallel produced a roughly one-in-ten failure that moved between suites — a 403
> where a 200 was expected, a 404 where a 403 was, a rate-limit window misbehaving — and never
> reproduced when a suite ran on its own, which is what made it look like flakiness. Serially it
> does not occur.
>
> Adding a suite is safe. Restoring parallelism is not, until each worker gets its own data root.

```text
test/
├── __mocks__/
├── fixtures/
├── app.e2e-spec.ts
├── baileys-engine.e2e-spec.ts
├── ingress-instance-throttle.e2e-spec.ts
├── integration-fabric.e2e-spec.ts
├── integration-instance.e2e-spec.ts
├── mcp-auth.e2e-spec.ts
├── queue-on.e2e-spec.ts
├── search.e2e-spec.ts
├── serve-static.e2e-spec.ts
├── session-scope.e2e-spec.ts
├── setup-e2e-env.e2e-spec.ts
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

| Scope                       | Branches | Functions | Lines | Statements |
| --------------------------- | -------- | --------- | ----- | ---------- |
| Global                      | 58%      | 63%       | 66%   | 65%        |
| `src/common/cache/`         | 34%      | 33%       | 42%   | 42%        |
| `src/common/security/`      | 85%      | 95%       | 93%   | 92%        |
| `src/common/services/`      | 74%      | 91%       | 87%   | 84%        |
| `src/common/storage/`       | 75%      | 80%       | 80%   | 77%        |
| `src/common/utils/`         | 86%      | 92%       | 92%   | 91%        |
| `src/config/`               | 88%      | 92%       | 91%   | 91%        |
| `src/core/agent-tools/`     | 88%      | 87%       | 83%   | 83%        |
| `src/core/hooks/`           | 81%      | 73%       | 85%   | 84%        |
| `src/core/plugins/`         | 72%      | 74%       | 81%   | 80%        |
| `src/database/`             | 69%      | 69%       | 72%   | 72%        |
| `src/engine/adapters/`      | 74%      | 84%       | 83%   | 83%        |
| `src/engine/identity/`      | 85%      | 95%       | 94%   | 93%        |
| `src/modules/audit/`        | 59%      | 45%       | 72%   | 68%        |
| `src/modules/auth/`         | 75%      | 85%       | 86%   | 85%        |
| `src/modules/automation/`   | 67%      | 57%       | 83%   | 79%        |
| `src/modules/chat-media/`   | 78%      | 81%       | 92%   | 90%        |
| `src/modules/contact/`      | 79%      | 90%       | 89%   | 88%        |
| `src/modules/docker/`       | 88%      | 99%       | 96%   | 96%        |
| `src/modules/events/`       | 70%      | 84%       | 81%   | 80%        |
| `src/modules/group/`        | 64%      | 47%       | 67%   | 67%        |
| `src/modules/infra/`        | 73%      | 71%       | 87%   | 86%        |
| `src/modules/integration/`  | 76%      | 83%       | 90%   | 89%        |
| `src/modules/mcp/`          | 62%      | 81%       | 78%   | 78%        |
| `src/modules/media/`        | 71%      | 87%       | 89%   | 88%        |
| `src/modules/message/`      | 57%      | 66%       | 81%   | 80%        |
| `src/modules/metrics/`      | 61%      | 65%       | 68%   | 65%        |
| `src/modules/plugins/`      | 67%      | 63%       | 74%   | 73%        |
| `src/modules/queue/`        | 74%      | 88%       | 95%   | 95%        |
| `src/modules/search/`       | 66%      | 87%       | 71%   | 71%        |
| `src/modules/session/`      | 75%      | 79%       | 88%   | 87%        |
| `src/modules/stats/`        | 67%      | 63%       | 71%   | 69%        |
| `src/modules/status-store/` | 79%      | 83%       | 92%   | 91%        |
| `src/modules/status/`       | 70%      | 58%       | 79%   | 78%        |
| `src/modules/template/`     | 77%      | 99%       | 92%   | 89%        |
| `src/modules/webhook/`      | 72%      | 89%       | 90%   | 87%        |

Set each floor about five points below that scope's measured coverage, so it catches a real
regression without failing on ordinary churn. Raise a floor when coverage rises; never lower one.

Two behaviours of Jest's threshold matching are worth knowing before adding a scope:

- A file counts toward **every** path key it matches — there is no most-specific-wins. Keys must
  therefore be disjoint, or a nested scope's files are graded twice and the parent floor becomes a
  restatement of the child.
- A file matched by any path key is **removed from the global group**. Global therefore grades only
  the scopes with no floor of their own, which is why its numbers are lower than the repository-wide
  figure and why adding a scope changes what Global means.

The stricter scoped gates protect security-sensitive code and high-risk boundary layers. When adding
security, engine-adapter, or integration-fabric behavior, add focused regression tests instead of relying
on broad integration coverage.

## 9.6 CI Checks

Main CI is defined in `.github/workflows/ci.yml`.

| Job             | Checks                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `lint`          | backend ESLint, full-program TypeScript check, formatting, version consistency, .dockerignore context, OpenAPI snapshot |
| `audit`         | dependency security audit                                                                                               |
| `test`          | backend coverage run, script unit tests (node:test), e2e smoke tests, Codecov upload                                    |
| `test-postgres` | real PostgreSQL 16 service, backend build, migration smoke, and PostgreSQL FTS provider spec                            |
| `dashboard`     | dashboard install, lint, test type-check, unit tests, i18n parity, build                                                |
| `scripts-smoke` | shellcheck on the backup/restore scripts plus the backup/restore smoke test                                             |
| `build`         | backend build after lint/audit/test/dashboard/scripts-smoke jobs pass                                                   |
| `docker`        | multi-arch Docker build on pushes and pull requests; publish only where workflow permissions allow                      |

SDK CI is defined in `.github/workflows/sdk-ci.yml` and is path-filtered to SDK sources plus server
contract surfaces that SDKs mirror (`src/**/dto/**`, `src/**/*.controller.ts`, `src/**/*.service.ts`, and
`src/engine/interfaces/whatsapp-engine.interface.ts`), so any backend controller or service change also
re-runs the SDK suites. It runs:

- JavaScript SDK tests, type-check, build, and dual CJS/ESM smoke test.
- Python SDK tests with `pytest`.
- PHP SDK tests with PHPUnit.
- Java SDK tests with Maven.
- Go SDK formatting, `go vet`, and race-enabled tests at the declared Go floor.

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
- The default `test` job uses SQLite; PostgreSQL 16 is only exercised by the dedicated `test-postgres` job.
- No default CI job exercises S3/MinIO or Docker socket proxy integration. (Redis is no longer a gap: the
  `test` job starts a `redis:7-alpine` service container so the queue-on e2e suite has a broker. That suite
  skips itself when no Redis is reachable, so it stays green on a machine without one.)
- Performance testing is not automated.
- Dashboard browser/visual UI tests are not currently automated; dashboard pure utility tests run via `npm --prefix dashboard run test:unit`.

These gaps are intentional because the project prioritizes deterministic tests: no job needs an
operator-owned WhatsApp account, cloud credentials, or a Docker socket, and neither service container CI
starts is required locally — `npm test` and `npm run test:e2e` stay on SQLite with the queue disabled. Add
opt-in integration jobs only when they are isolated, documented, and do not make normal contributor
workflows brittle.

---

<div align="center">

[← 08 - Development Guidelines](./08-development-guidelines.md) · [Documentation Index](./README.md) · [Next: 10 - DevOps & Infrastructure →](./10-devops-infrastructure.md)

</div>
