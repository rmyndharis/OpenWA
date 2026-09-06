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
> state is redirected to a per-worker location. The plugin registry once had no environment
> lever, so every worker's plugin loader read-modify-wrote the same
> `data/plugins/registry.json`. `PLUGIN_STATE_DIR` now redirects it and each suite takes its own state
> roots, so that particular collision is closed. Measured on a single parallel run: 52 writes from 12 processes, 30
> of them within 500ms of a write by a different process. Individual writes are atomic; the
> read-modify-write cycle is not.
>
> Running them in parallel produced a roughly one-in-ten failure that moved between suites — a 403
> where a 200 was expected, a 404 where a 403 was, a rate-limit window misbehaving — and never
> reproduced when a suite ran on its own, which is what made it look like flakiness. Serially it
> does not occur.
>
> Adding a suite is safe. Restoring parallelism has not been retried since those roots landed, so it
> is untested rather than known-safe.
>
> A second requirement has nothing to do with parallelism: each suite's server is put on a **loopback**
> port while it initialises (`test/setup-e2e.ts`). Left alone, supertest starts a listener per request
> on the wildcard address and then dials 127.0.0.1, and macOS both permits that bind over a port
> another process holds on 127.0.0.1 specifically and routes the connection to the more specific
> holder. An assertion then reads a status from an unrelated program on the host, which is why the lane
> could fail on a status no route can return. `setup-e2e-env.e2e-spec.ts` holds that contract.

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
| Global                      | 54%      | 68%       | 60%   | 61%        |
| `src/common/cache/`         | 34%      | 33%       | 42%   | 42%        |
| `src/common/security/`      | 85%      | 95%       | 93%   | 92%        |
| `src/common/services/`      | 82%      | 91%       | 90%   | 88%        |
| `src/common/storage/`       | 75%      | 85%       | 84%   | 80%        |
| `src/common/utils/`         | 87%      | 92%       | 92%   | 92%        |
| `src/config/`               | 85%      | 92%       | 91%   | 91%        |
| `src/core/agent-tools/`     | 83%      | 86%       | 83%   | 83%        |
| `src/core/hooks/`           | 84%      | 71%       | 86%   | 85%        |
| `src/core/plugins/`         | 73%      | 76%       | 82%   | 81%        |
| `src/database/`             | 69%      | 69%       | 72%   | 72%        |
| `src/engine/adapters/`      | 78%      | 85%       | 86%   | 86%        |
| `src/engine/identity/`      | 85%      | 86%       | 94%   | 93%        |
| `src/modules/audit/`        | 59%      | 45%       | 73%   | 70%        |
| `src/modules/auth/`         | 76%      | 85%       | 86%   | 86%        |
| `src/modules/automation/`   | 67%      | 86%       | 83%   | 79%        |
| `src/modules/call/`         | 62%      | 57%       | 82%   | 79%        |
| `src/modules/catalog/`      | 68%      | 88%       | 89%   | 87%        |
| `src/modules/channel/`      | 73%      | 41%       | 76%   | 75%        |
| `src/modules/chat-media/`   | 75%      | 72%       | 84%   | 84%        |
| `src/modules/contact/`      | 82%      | 92%       | 89%   | 88%        |
| `src/modules/docker/`       | 84%      | 93%       | 92%   | 92%        |
| `src/modules/events/`       | 72%      | 84%       | 84%   | 82%        |
| `src/modules/group/`        | 67%      | 65%       | 79%   | 79%        |
| `src/modules/health/`       | 77%      | 66%       | 90%   | 87%        |
| `src/modules/infra/`        | 75%      | 76%       | 89%   | 88%        |
| `src/modules/integration/`  | 76%      | 83%       | 90%   | 89%        |
| `src/modules/label/`        | 39%      | 42%       | 45%   | 44%        |
| `src/modules/mcp/`          | 62%      | 76%       | 78%   | 78%        |
| `src/modules/media/`        | 69%      | 86%       | 89%   | 88%        |
| `src/modules/message/`      | 75%      | 66%       | 86%   | 85%        |
| `src/modules/metrics/`      | 64%      | 58%       | 70%   | 67%        |
| `src/modules/plugins/`      | 69%      | 64%       | 77%   | 76%        |
| `src/modules/profile/`      | 78%      | 84%       | 88%   | 85%        |
| `src/modules/queue/`        | 74%      | 81%       | 95%   | 95%        |
| `src/modules/search/`       | 69%      | 86%       | 78%   | 78%        |
| `src/modules/session/`      | 75%      | 79%       | 88%   | 87%        |
| `src/modules/settings/`     | 50%      | 0%        | 85%   | 81%        |
| `src/modules/stats/`        | 67%      | 63%       | 78%   | 76%        |
| `src/modules/status-store/` | 79%      | 79%       | 92%   | 91%        |
| `src/modules/status/`       | 70%      | 60%       | 83%   | 82%        |
| `src/modules/template/`     | 76%      | 87%       | 91%   | 89%        |
| `src/modules/takeover/`     | 74%      | 70%       | 85%   | 83%        |
| `src/modules/webhook/`      | 72%      | 89%       | 90%   | 87%        |

When raising a floor, set it about five points below that scope's measured coverage, so it catches
a real regression without failing on ordinary churn, and then check that gap in UNITS rather than
percent. Five points is denominator-blind: on a scope with 14 functions it buys nothing, and a floor
that admits zero growth has stopped measuring coverage and started blocking ordinary change. Every
floor here leaves room for at least two newly uncovered units of its metric, which is the one case
where a floor may be lowered: not because coverage fell, but because the margin was unattainable. When coverage legitimately shifts — a refactor
relocating covered logic, a lane split changing which specs a lane runs — reset the floor to the
newly measured coverage instead. Floors exist to catch regressions, not to force coverage.

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

| Job             | Checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lint`          | backend ESLint, full-program TypeScript check, formatting, version consistency, .dockerignore context, OpenAPI snapshot, SDK routes and webhook events against the contract, contract coverage per SDK, SDK docs against the shipped client surface, client wire shapes (`check:contract-shapes` — the JavaScript SDK's, dashboard's, Python's, Go's and Java's hand-written types against the OpenAPI schemas; the PHP client returns untyped arrays and has no types layer to gate) |
| `audit`         | dependency security audit of BOTH npm trees (root and `dashboard/`)                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `test`          | backend coverage run, script unit tests (node:test), e2e smoke tests, Codecov upload                                                                                                                                                                                                                                                                                                                                                                                                  |
| `test-postgres` | real PostgreSQL 16 service, backend build, migration smoke, and PostgreSQL FTS provider spec                                                                                                                                                                                                                                                                                                                                                                                          |
| `dashboard`     | dashboard install, lint, formatting, type-check, i18n parity, build, unit tests                                                                                                                                                                                                                                                                                                                                                                                                       |
| `scripts-smoke` | shellcheck on `docker-entrypoint.sh` and every `scripts/*.sh`, plus the backup/restore smoke test                                                                                                                                                                                                                                                                                                                                                                                     |
| `chart`         | helm lint, helm template with default and fully-toggled values, kubeconform on both renders, the rendered-behaviour check, actionlint on the workflows                                                                                                                                                                                                                                                                                                                                |
| `build`         | backend build after lint/audit/test/dashboard/scripts-smoke/chart jobs pass                                                                                                                                                                                                                                                                                                                                                                                                           |
| `docker`        | multi-arch Docker build on pushes and pull requests, then `scripts/smoke-test-non-root.sh` against the built image so the entrypoint's root→openwa drop is verified, not assumed; publishes to GHCR only on push, so fork pull requests validate both architectures without publishing                                                                                                                                                                                                |

SDK CI is defined in `.github/workflows/sdk-ci.yml` and is path-filtered to SDK sources plus server
contract surfaces that SDKs mirror (`src/**/dto/**`, `src/**/*.controller.ts`, `src/**/*.service.ts`, and
`src/engine/interfaces/whatsapp-engine.interface.ts`), so any backend controller or service change also
re-runs the SDK suites. It runs:

- JavaScript SDK tests, type-check, build, and dual CJS/ESM smoke test.
- Python SDK tests with `pytest`.
- PHP SDK tests with PHPUnit.
- Java SDK tests with Maven.
- Go SDK formatting, `go vet`, and race-enabled tests at the declared Go floor.

Release tags run `.github/workflows/release.yml`, which mirrors the CI gate rather than running a
lighter one: the same lint job (including all four SDK contract checks), the same test, PostgreSQL,
dashboard, shell-script and chart jobs. It additionally verifies the tag matches `package.json`, and
publishes the GitHub Release only after the Docker image has built and pushed successfully. Nothing in
it packages or publishes the Helm chart — operators install that from the tagged ref, so the tag is the
last gate the chart passes.

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
