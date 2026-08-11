import { readFileSync, readdirSync } from 'fs';
import { join, relative, sep } from 'path';
import { ApiKeyUsageTracker } from './api-key-usage-tracker.service';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';

/**
 * The usage-stat write must carry usage state and nothing else.
 *
 * Authentication loads the whole key row and hands the entity to the usage tracker, which mutates
 * `lastUsedAt`/`usageCount` on it and persists on a 60s window. Persisting that entity WHOLE writes
 * every column back — including `isActive`, `role`, `allowedSessions`, `allowedIps` and `expiresAt`
 * as they were when the request began. An administrator change committed between the load and the
 * windowed write is silently reverted by an advisory statistics update. Revocation is a hard delete,
 * so the same write on a removed key is an INSERT rather than an UPDATE: the credential comes back
 * with its original hash and authenticates again.
 *
 * `forget()` is called by revoke() before its deactivating save and closes the window for a key with
 * only PENDING counters. It cannot reach an entity a request handler is already holding, which is the
 * case these tests pin.
 *
 * The shutdown path already writes correctly — `flushPending` uses an atomic column increment and its
 * own comment warns against "reloading the row and saving it back". These tests hold the hot path to
 * the same standard.
 */

function makeRow(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'key-1',
    name: 'Test Key',
    keyHash: 'hash',
    keyPrefix: 'prefix',
    role: ApiKeyRole.OPERATOR,
    allowedIps: null,
    allowedSessions: null,
    isActive: true,
    expiresAt: null,
    lastUsedAt: null,
    usageCount: 5,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * A repository standing in for one persisted row: `save` writes the whole entity over it, `update`
 * writes only the named columns. That asymmetry is the entire subject of these tests, so the double
 * models it rather than asserting on which method was called.
 */
function makeRepository(row: ApiKey) {
  return {
    save: jest.fn((entity: ApiKey) => {
      Object.assign(row, entity);
      return Promise.resolve(entity);
    }),
    update: jest.fn((_criteria: unknown, patch: Partial<ApiKey>) => {
      Object.assign(row, patch);
      return Promise.resolve({ affected: 1 });
    }),
    increment: jest.fn(() => Promise.resolve({ affected: 1 })),
  };
}

/** The columns the usage write is allowed to touch. */
const USAGE_COLUMNS = ['lastUsedAt', 'usageCount'];

describe('API-key usage write scope', () => {
  it('does not resurrect a key revoked while the request was in flight', async () => {
    const row = makeRow();
    const repository = makeRepository(row);
    const tracker = new ApiKeyUsageTracker(repository as never);

    // A request authenticates and the handler now holds its own copy of the row.
    const heldByRequest = { ...row };

    // An administrator revokes the key while that request is still in flight. forget() clears any
    // PENDING counter but cannot reach the entity above.
    row.isActive = false;
    tracker.forget(row.id);

    // The windowed usage write fires (lastUsedAt is null, so the window is due immediately).
    await tracker.record(heldByRequest);

    expect(row.isActive).toBe(false);
  });

  it('does not revert an authorisation narrowing committed while the request was in flight', async () => {
    const row = makeRow({ role: ApiKeyRole.ADMIN });
    const repository = makeRepository(row);
    const tracker = new ApiKeyUsageTracker(repository as never);

    const heldByRequest = { ...row };

    // Narrowed on every authorisation dimension at once.
    row.role = ApiKeyRole.VIEWER;
    row.allowedSessions = ['session-a'];
    row.allowedIps = ['10.0.0.1'];
    row.expiresAt = new Date('2020-01-01T00:00:00.000Z');

    await tracker.record(heldByRequest);

    expect(row.role).toBe(ApiKeyRole.VIEWER);
    expect(row.allowedSessions).toEqual(['session-a']);
    expect(row.allowedIps).toEqual(['10.0.0.1']);
    expect(row.expiresAt).toEqual(new Date('2020-01-01T00:00:00.000Z'));
  });

  it('persists exactly the two usage columns and no others', async () => {
    const row = makeRow();
    const repository = makeRepository(row);
    const tracker = new ApiKeyUsageTracker(repository as never);

    await tracker.record({ ...row });

    const updateCall = repository.update.mock.calls[0];
    const saveCall = repository.save.mock.calls[0];
    const written: Partial<ApiKey> = updateCall ? updateCall[1] : saveCall[0];

    expect(Object.keys(written).sort()).toEqual([...USAGE_COLUMNS].sort());
    // Neither column may arrive undefined. TypeORM strips an undefined value from the SET clause
    // rather than writing NULL, so an undefined here is not a wipe — it is a write that silently
    // updates nothing but `updatedAt`, and the statistics stop advancing with no error to notice.
    expect(written.lastUsedAt).toBeInstanceOf(Date);
    expect(typeof written.usageCount).toBe('number');
  });

  it('aims the write at the row it loaded and no other', async () => {
    const row = makeRow();
    const repository = makeRepository(row);
    const tracker = new ApiKeyUsageTracker(repository as never);

    await tracker.record({ ...row });

    // Blast radius, not column scope. The double writes whatever patch it is handed to the single row
    // it models, so every assertion about WHAT is written holds just as well for a write aimed at the
    // wrong rows: `update({ isActive: true }, ...)` — which TypeORM accepts — would stamp one key's
    // statistics onto every active key, and passes all of the tests above.
    expect(repository.update.mock.calls[0][0]).toEqual({ id: row.id });
  });

  it('still returns the incremented counters on the entity the caller holds', async () => {
    const row = makeRow({ usageCount: 5 });
    const repository = makeRepository(row);
    const tracker = new ApiKeyUsageTracker(repository as never);

    const heldByRequest = { ...row };
    await tracker.record(heldByRequest);

    expect(heldByRequest.usageCount).toBe(6);
    expect(heldByRequest.lastUsedAt).toBeInstanceOf(Date);
  });

  it('keeps a failed usage write non-fatal', async () => {
    const row = makeRow();
    const repository = makeRepository(row);
    repository.update.mockRejectedValueOnce(new Error('db down'));
    repository.save.mockRejectedValueOnce(new Error('db down'));
    const tracker = new ApiKeyUsageTracker(repository as never);

    await expect(tracker.record({ ...row })).resolves.toBeUndefined();
  });
});

/**
 * Structural guard for the entrypoint dimension of the same bug.
 *
 * The defect lives in the usage write, which every authentication path reaches through
 * validateApiKey. An enumeration that misses an entrypoint produces a fix that looks complete and
 * leaves a path uncovered — the websocket re-validation in events.gateway.ts was missed exactly once
 * during analysis of this defect. This test fails when a new call site appears, so the next
 * enumeration cannot silently be short.
 */
describe('validateApiKey entrypoint coverage', () => {
  /** Every known caller, with the surface it authenticates. */
  const KNOWN_CALLERS = new Map<string, string>([
    ['core/agent-tools/tool-invoker.ts', 'agent tool invocation'],
    ['common/security/bull-board-auth.middleware.ts', 'queue dashboard middleware'],
    ['modules/auth/guards/api-key.guard.ts', 'REST route guard'],
    ['modules/events/events.gateway.ts', 'websocket connect and per-subscribe re-validation'],
  ]);

  /** Where validateApiKey is declared, which is not a caller. */
  const DEFINITION = 'modules/auth/auth.service.ts';

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) out.push(full);
    }
    return out;
  }

  it('enumerates every caller of validateApiKey', () => {
    const srcRoot = join(__dirname, '..', '..');

    const callers = walk(srcRoot)
      .filter(file => /\bvalidateApiKey\s*\(/.test(readFileSync(file, 'utf8')))
      .map(file => relative(srcRoot, file).split(sep).join('/'))
      .filter(rel => rel !== DEFINITION)
      .sort();

    expect(callers).toEqual([...KNOWN_CALLERS.keys()].sort());
  });
});
