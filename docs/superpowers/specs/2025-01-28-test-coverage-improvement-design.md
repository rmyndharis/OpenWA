# Test Coverage Improvement Design

**Date:** 2025-01-28
**Author:** Claude (OpenWA)
**Status:** In Progress

## Objective

Increase test coverage from ~66% to 80% while fixing Windows-specific test failures and ensuring zero regressions.

## Progress Snapshot

Status on 2026-06-28 after the Windows portability/hardening pass:

- Backend unit tests pass on Windows: 113 suites / 1481 tests.
- Coverage run passes with current baseline: 66.09% statements, 59.19% branches, 61.72% functions, 66.87% lines.
- Windows-specific permission assertions now stay strict on POSIX and platform-aware on Windows.
- Plugin storage keys are encoded to filesystem-safe names while retaining logical keys and legacy reads.
- Remaining work: raise coverage to the 80% target.

## Scope

### In Scope
- All `src/**/*.spec.ts` files
- Critical business logic modules
- Unit, integration, and hybrid tests
- Windows-specific test fixes

### Out of Scope
- Dashboard tests (separate repository)
- SDK tests (separate repositories)
- Documentation tests

### Target Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Line coverage | 66.87% | 80% |
| Branch coverage | 59.19% | 75% |
| Function coverage | 61.72% | 75% |
| Passing tests | 1481/1481 | 100% |

## Module Priority

1. **Authentication** - API keys, RBAC, guards (target: 90%)
2. **Session Management** - Lifecycle, reconnect (target: 85%)
3. **Message Operations** - Send, receive, status (target: 85%)
4. **Webhook Delivery** - Dispatch, retry, idempotency (target: 85%)
5. **Engine Adapters** - Mappers, identity resolution (target: 80%)
6. **Plugin System** - Sandbox, hooks, IPC (target: 75%)
7. **Storage & Media** - S3, uploads (target: 80%)
8. **Infrastructure** - Config, database (target: 85%)

## Test Architecture

### Layer 1: Unit Tests
- Mock all external dependencies
- Test business logic in isolation
- Target: < 10ms per test

### Layer 2: Integration Tests
- Real TypeORM with SQLite test database
- Mock external services (WhatsApp, HTTP)
- Target: < 100ms per test

### Layer 3: Hybrid Tests
- Real database + mocked engines
- Test service-to-service integration

### Layer 4: Smoke Tests
- Real WhatsApp connection
- Manual trigger before releases

## Test Fixtures Structure

```
test/fixtures/
├── sessions/
├── messages/
├── webhooks/
└── auth/
```

## Windows-Specific Fixes

Use platform-specific assertions for file permissions:

```typescript
const getFilePermissions = (path: string): number => {
  if (platform.platform() === 'win32') {
    return fs.statSync(path).mode & 0o777;
  }
  return fs.statSync(path).mode;
};
```

## Implementation Timeline

| Week | Focus | Deliverables |
|------|-------|--------------|
| 1 | Auth + Session | 80%+ coverage, Windows fixes |
| 2 | Message + Webhook | 80%+ coverage |
| 3 | Engine + Plugins + Storage | 80%+ overall |

## Success Criteria

- All tests passing (0 failures)
- Coverage targets met
- Zero regressions in existing functionality
