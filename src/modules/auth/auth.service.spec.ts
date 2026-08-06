// Spread the real fs so every method passes through, but as configurable props the test can spy on
// (the bare `import * as fs` namespace is non-configurable, so jest.spyOn can't redefine its methods).
jest.mock('fs', () => ({ __esModule: true, ...jest.requireActual<typeof import('fs')>('fs') }));

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FindOperator, Repository } from 'typeorm';
import { UnauthorizedException, NotFoundException, ConflictException } from '@nestjs/common';
import { createHash, createHmac } from 'crypto';
import * as fs from 'fs';
import { AuthService, resolveSeedApiKey, bannerKeyLine } from './auth.service';
import { ApiKeyUsageTracker } from './api-key-usage-tracker.service';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';

// Helpers
const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

function createMockApiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'uuid-1',
    name: 'Test Key',
    keyHash: hashKey('test-key'),
    keyPrefix: 'test-key-pre',
    role: ApiKeyRole.OPERATOR,
    allowedIps: null,
    allowedSessions: null,
    isActive: true,
    expiresAt: null,
    lastUsedAt: null,
    usageCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('resolveSeedApiKey (first-boot default admin key)', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.API_MASTER_KEY;
    delete process.env.ALLOW_DEV_API_KEY;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('uses API_MASTER_KEY verbatim when set', () => {
    process.env.API_MASTER_KEY = 'my-explicit-master-key';
    expect(resolveSeedApiKey()).toBe('my-explicit-master-key');
  });

  it('generates a random owa_k1_ key by default (no opt-in)', () => {
    expect(resolveSeedApiKey()).toMatch(/^owa_k1_[a-f0-9]{64}$/);
  });

  it('returns the fixed dev-admin-key only when ALLOW_DEV_API_KEY=true', () => {
    process.env.ALLOW_DEV_API_KEY = 'true';
    expect(resolveSeedApiKey()).toBe('dev-admin-key');
  });

  it('prefers API_MASTER_KEY over the dev opt-in', () => {
    process.env.API_MASTER_KEY = 'master-wins';
    process.env.ALLOW_DEV_API_KEY = 'true';
    expect(resolveSeedApiKey()).toBe('master-wins');
  });
});

describe('bannerKeyLine (startup banner key masking)', () => {
  const FULL = 'owa_k1_0123456789abcdef0123456789abcdef';

  it('prints the full key only when it was just created', () => {
    expect(bannerKeyLine(FULL, true)).toBe(FULL);
  });

  it('masks the key on subsequent boots — the full secret is never re-logged', () => {
    const line = bannerKeyLine(FULL, false);
    expect(line).not.toContain('0123456789abcdef'); // the secret tail must not appear
    expect(line.startsWith('owa_k1_0')).toBe(true); // a short fingerprint is fine
    expect(line).toMatch(/data\/\.api-key|dashboard/); // points the operator to the real source
  });

  it('passes a placeholder through unchanged', () => {
    expect(bannerKeyLine('(check dashboard for keys)', false)).toBe('(check dashboard for keys)');
  });
});

describe('AuthService', () => {
  let service: AuthService;
  let repository: jest.Mocked<Partial<Repository<ApiKey>>>;

  beforeEach(async () => {
    repository = {
      count: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      remove: jest.fn(),
      increment: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        ApiKeyUsageTracker,
        {
          provide: getRepositoryToken(ApiKey, 'main'),
          useValue: repository,
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  // ── last-admin guard test double ──────────────────────────────────

  /**
   * In-memory stand-in for the api_keys table: findOne()/count()/save()/remove() backed by a Map.
   * count() HONORS the where-clause — the last-admin guard's query filters on role/isActive/
   * expiresAt AND session scope, so a mock that ignores the predicate (e.g. reporting a fixed
   * set size) would let a session-scoped admin count as a surviving key manager and the
   * allowedSessions filter would never actually be exercised. Interleaving is driven purely by
   * promise resolution order, so concurrency scenarios stay deterministic regardless of which
   * request runs its critical section first.
   */
  function setupKeys(seed: ApiKey[]): void {
    const keys = new Map(seed.map(k => [k.id, k]));
    (repository.findOne as jest.Mock).mockImplementation((options: { where: { id: string } }) =>
      Promise.resolve(keys.get(options.where.id) ?? null),
    );
    (repository.count as jest.Mock).mockImplementation((options?: { where?: Array<Record<string, unknown>> }) =>
      Promise.resolve(
        [...keys.values()].filter(k => (options?.where ?? []).some(branch => matchesWhere(k, branch))).length,
      ),
    );
    (repository.remove as jest.Mock).mockImplementation((key: ApiKey) => {
      keys.delete(key.id);
      return Promise.resolve(key);
    });
    (repository.save as jest.Mock).mockImplementation((key: ApiKey) => {
      keys.set(key.id, key);
      return Promise.resolve(key);
    });
  }

  function setupLiveAdmins(...ids: string[]): void {
    setupKeys(ids.map(id => createMockApiKey({ id, role: ApiKeyRole.ADMIN })));
  }

  /** OR semantics across the where array; AND across the fields of a single branch. */
  function matchesWhere(key: ApiKey, branch: Record<string, unknown>): boolean {
    return Object.entries(branch).every(([field, condition]) => matchesCondition(dbColumnValue(key, field), condition));
  }

  /** Mirror the simple-array columns' stored shape: null stays null, an array is stored as a CSV. */
  function dbColumnValue(key: ApiKey, field: string): unknown {
    const value = (key as unknown as Record<string, unknown>)[field];
    if ((field === 'allowedSessions' || field === 'allowedIps') && Array.isArray(value)) return value.join(',');
    return value;
  }

  function matchesCondition(value: unknown, condition: unknown): boolean {
    if (condition instanceof FindOperator) {
      switch (condition.type) {
        case 'not':
          return !matchesCondition(value, condition.value);
        case 'isNull':
          return value === null || value === undefined;
        case 'moreThan':
          return (
            value instanceof Date && condition.value instanceof Date && value.getTime() > condition.value.getTime()
          );
        case 'equal':
          return value === condition.value;
        default:
          throw new Error(`unsupported FindOperator in count mock: ${String(condition.type)}`);
      }
    }
    return value === condition;
  }

  // ── createApiKey ──────────────────────────────────────────────────

  describe('createApiKey', () => {
    it('should generate a key with owa_k1_ prefix and save to DB', async () => {
      const mockSaved = createMockApiKey({ name: 'My Key' });
      (repository.create as jest.Mock).mockReturnValue(mockSaved);
      (repository.save as jest.Mock).mockResolvedValue(mockSaved);

      const result = await service.createApiKey({ name: 'My Key' });

      expect(result.rawKey).toMatch(/^owa_k1_[a-f0-9]{64}$/);
      expect(result.apiKey).toBe(mockSaved);
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'My Key',
          role: ApiKeyRole.OPERATOR, // default
        }),
      );
    });

    it('should use the provided role instead of default', async () => {
      const mockSaved = createMockApiKey({ role: ApiKeyRole.ADMIN });
      (repository.create as jest.Mock).mockReturnValue(mockSaved);
      (repository.save as jest.Mock).mockResolvedValue(mockSaved);

      await service.createApiKey({ name: 'Admin Key', role: ApiKeyRole.ADMIN });

      expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ role: ApiKeyRole.ADMIN }));
    });

    it('should store the SHA-256 hash, not the raw key', async () => {
      const mockSaved = createMockApiKey();
      (repository.create as jest.Mock).mockReturnValue(mockSaved);
      (repository.save as jest.Mock).mockResolvedValue(mockSaved);

      const result = await service.createApiKey({ name: 'Test' });

      const expectedHash = hashKey(result.rawKey);
      expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ keyHash: expectedHash }));
    });
  });

  // ── findAll / findOne ─────────────────────────────────────────────

  describe('findAll', () => {
    it('should return all API keys ordered by createdAt DESC', async () => {
      const keys = [createMockApiKey(), createMockApiKey({ id: 'uuid-2' })];
      (repository.find as jest.Mock).mockResolvedValue(keys);

      const result = await service.findAll();

      expect(result).toHaveLength(2);
      expect(repository.find).toHaveBeenCalledWith({ order: { createdAt: 'DESC' } });
    });
  });

  describe('findOne', () => {
    it('should return the API key if found', async () => {
      const key = createMockApiKey();
      (repository.findOne as jest.Mock).mockResolvedValue(key);

      const result = await service.findOne('uuid-1');
      expect(result).toBe(key);
    });

    it('should throw NotFoundException if key not found', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(null);

      await expect(service.findOne('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  // ── update ────────────────────────────────────────────────────────

  describe('update', () => {
    it('should update only the provided fields', async () => {
      const key = createMockApiKey();
      (repository.findOne as jest.Mock).mockResolvedValue(key);
      (repository.save as jest.Mock).mockImplementation(k => Promise.resolve(k));

      const result = await service.update('uuid-1', { name: 'Updated' });

      expect(result.name).toBe('Updated');
      expect(result.role).toBe(ApiKeyRole.OPERATOR); // unchanged
    });

    it('evicts active WebSocket sockets when allowedSessions narrows', async () => {
      const evictApiKey = jest.fn();
      jest
        .spyOn((service as unknown as { moduleRef: { get: (...a: unknown[]) => unknown } }).moduleRef, 'get')
        .mockReturnValue({ evictApiKey });
      const key = createMockApiKey({ allowedSessions: ['sess-A', 'sess-B'] });
      (repository.findOne as jest.Mock).mockResolvedValue(key);
      (repository.save as jest.Mock).mockImplementation(k => Promise.resolve(k));

      await service.update('uuid-1', { allowedSessions: ['sess-A'] });

      expect(evictApiKey).toHaveBeenCalledWith('uuid-1', 'authorization_changed');
    });

    it('evicts active WebSocket sockets when the role changes', async () => {
      const evictApiKey = jest.fn();
      jest
        .spyOn((service as unknown as { moduleRef: { get: (...a: unknown[]) => unknown } }).moduleRef, 'get')
        .mockReturnValue({ evictApiKey });
      const key = createMockApiKey({ role: ApiKeyRole.OPERATOR });
      (repository.findOne as jest.Mock).mockResolvedValue(key);
      (repository.save as jest.Mock).mockImplementation(k => Promise.resolve(k));

      await service.update('uuid-1', { role: ApiKeyRole.ADMIN });

      expect(evictApiKey).toHaveBeenCalledWith('uuid-1', 'authorization_changed');
    });

    it('does not evict on a benign (name-only) update', async () => {
      const evictApiKey = jest.fn();
      jest
        .spyOn((service as unknown as { moduleRef: { get: (...a: unknown[]) => unknown } }).moduleRef, 'get')
        .mockReturnValue({ evictApiKey });
      const key = createMockApiKey({ name: 'original' });
      (repository.findOne as jest.Mock).mockResolvedValue(key);
      (repository.save as jest.Mock).mockImplementation(k => Promise.resolve(k));

      await service.update('uuid-1', { name: 'renamed' });

      expect(evictApiKey).not.toHaveBeenCalled();
    });

    it('rejects demoting or expiring the last usable admin', async () => {
      const key = createMockApiKey({ role: ApiKeyRole.ADMIN });
      (repository.findOne as jest.Mock).mockResolvedValue(key);
      (repository.count as jest.Mock).mockResolvedValue(0);

      await expect(service.update('uuid-1', { role: ApiKeyRole.OPERATOR })).rejects.toThrow(/last active admin/i);
      await expect(
        service.update('uuid-1', { expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      ).rejects.toThrow(/last active admin/i);
      expect(repository.save).not.toHaveBeenCalled();
    });
  });

  // ── delete / revoke ───────────────────────────────────────────────

  describe('delete', () => {
    it('should remove the API key from DB', async () => {
      const key = createMockApiKey();
      (repository.findOne as jest.Mock).mockResolvedValue(key);
      (repository.remove as jest.Mock).mockResolvedValue(key);

      await service.delete('uuid-1');

      expect(repository.remove).toHaveBeenCalledWith(key);
    });

    it('should throw NotFoundException for non-existent key', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(null);

      await expect(service.delete('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('evicts active WebSocket sockets authenticated with the deleted key', async () => {
      const evictApiKey = jest.fn();
      jest
        .spyOn((service as unknown as { moduleRef: { get: (...a: unknown[]) => unknown } }).moduleRef, 'get')
        .mockReturnValue({ evictApiKey });

      const key = createMockApiKey();
      (repository.findOne as jest.Mock).mockResolvedValue(key);
      (repository.remove as jest.Mock).mockResolvedValue(key);

      await service.delete('uuid-1');

      expect(repository.remove).toHaveBeenCalledWith(key);
      expect(evictApiKey).toHaveBeenCalledWith('uuid-1', 'deleted');
    });

    it('rejects deleting the last usable admin but allows it when another usable admin exists', async () => {
      const key = createMockApiKey({ role: ApiKeyRole.ADMIN });
      (repository.findOne as jest.Mock).mockResolvedValue(key);
      (repository.remove as jest.Mock).mockResolvedValue(key);
      (repository.count as jest.Mock).mockResolvedValueOnce(0).mockResolvedValueOnce(1);

      await expect(service.delete('uuid-1')).rejects.toThrow(/last active admin/i);
      await expect(service.delete('uuid-1')).resolves.toBeUndefined();
      expect(repository.remove).toHaveBeenCalledTimes(1);
    });
  });

  describe('revoke', () => {
    it('should set isActive to false', async () => {
      const key = createMockApiKey({ isActive: true });
      (repository.findOne as jest.Mock).mockResolvedValue(key);
      (repository.save as jest.Mock).mockImplementation(k => Promise.resolve(k));

      const result = await service.revoke('uuid-1');

      expect(result.isActive).toBe(false);
    });

    it('evicts active WebSocket sockets authenticated with the revoked key', async () => {
      const evictApiKey = jest.fn();
      jest
        .spyOn((service as unknown as { moduleRef: { get: (...a: unknown[]) => unknown } }).moduleRef, 'get')
        .mockReturnValue({ evictApiKey });

      const key = createMockApiKey({ isActive: true });
      (repository.findOne as jest.Mock).mockResolvedValue(key);
      (repository.save as jest.Mock).mockImplementation(k => Promise.resolve(k));

      await service.revoke('uuid-1');

      expect(key.isActive).toBe(false);
      expect(evictApiKey).toHaveBeenCalledWith('uuid-1', 'revoked');
    });

    it('does not roll back the revoke if WebSocket eviction throws (best-effort)', async () => {
      jest
        .spyOn((service as unknown as { moduleRef: { get: (...a: unknown[]) => unknown } }).moduleRef, 'get')
        .mockImplementation(() => {
          throw new Error('gateway unavailable');
        });

      const key = createMockApiKey({ isActive: true });
      (repository.findOne as jest.Mock).mockResolvedValue(key);
      (repository.save as jest.Mock).mockImplementation(k => Promise.resolve(k));

      const result = await service.revoke('uuid-1');

      expect(result.isActive).toBe(false); // revoke still succeeded
    });

    it('rejects revoking the last usable admin', async () => {
      const key = createMockApiKey({ role: ApiKeyRole.ADMIN, isActive: true });
      (repository.findOne as jest.Mock).mockResolvedValue(key);
      (repository.count as jest.Mock).mockResolvedValue(0);

      await expect(service.revoke('uuid-1')).rejects.toThrow(/last active admin/i);
      expect(repository.save).not.toHaveBeenCalled();
      expect(key.isActive).toBe(true);
    });
  });

  // ── last-admin guard under concurrency ─────────────────────────────

  describe('last-admin guard under concurrency', () => {
    const outcomes = (results: PromiseSettledResult<unknown>[]) => ({
      succeeded: results.filter(r => r.status === 'fulfilled'),
      conflicts: results.filter(r => r.status === 'rejected' && r.reason instanceof ConflictException),
    });

    it('rejects exactly one of two concurrent deletes against the last two admins', async () => {
      setupLiveAdmins('admin-a', 'admin-b');

      // Without serialization both counts run before either remove commits and both deletes pass.
      const results = await Promise.allSettled([service.delete('admin-a'), service.delete('admin-b')]);

      const { succeeded, conflicts } = outcomes(results);
      expect(succeeded).toHaveLength(1);
      expect(conflicts).toHaveLength(1);
      expect(repository.remove).toHaveBeenCalledTimes(1); // one admin survives — no lockout
    });

    it('rejects exactly one of a concurrent demote and revoke against the last two admins', async () => {
      setupLiveAdmins('admin-a', 'admin-b');

      const results = await Promise.allSettled([
        service.update('admin-a', { role: ApiKeyRole.OPERATOR }),
        service.revoke('admin-b'),
      ]);

      const { succeeded, conflicts } = outcomes(results);
      expect(succeeded).toHaveLength(1);
      expect(conflicts).toHaveLength(1);
      // The loser's write never happened: exactly one capability-stripping write in total.
      const strippingSaves = (repository.save as jest.Mock).mock.calls.filter(
        ([key]: [ApiKey]) => key.role !== ApiKeyRole.ADMIN || key.isActive === false,
      );
      expect((repository.remove as jest.Mock).mock.calls.length + strippingSaves.length).toBe(1);
    });

    it('lets concurrent deletes proceed when another usable admin remains', async () => {
      setupLiveAdmins('admin-a', 'admin-b', 'admin-c');

      const results = await Promise.allSettled([service.delete('admin-a'), service.delete('admin-b')]);

      const { succeeded, conflicts } = outcomes(results);
      expect(succeeded).toHaveLength(2);
      expect(conflicts).toHaveLength(0);
      expect(repository.remove).toHaveBeenCalledTimes(2);
    });

    it('keeps non-admin mutations and benign admin updates off the mutex (no contention)', async () => {
      const lockRun = jest.spyOn(
        (service as unknown as { adminCapabilityLock: { run: (...args: unknown[]) => unknown } }).adminCapabilityLock,
        'run',
      );
      const operatorKey = createMockApiKey({ id: 'op-1', role: ApiKeyRole.OPERATOR });
      const adminKey = createMockApiKey({ id: 'adm-1', role: ApiKeyRole.ADMIN });
      (repository.findOne as jest.Mock).mockImplementation((options: { where: { id: string } }) =>
        Promise.resolve(options.where.id === 'op-1' ? operatorKey : adminKey),
      );
      (repository.remove as jest.Mock).mockImplementation((key: ApiKey) => Promise.resolve(key));
      (repository.save as jest.Mock).mockImplementation((key: ApiKey) => Promise.resolve(key));

      await service.delete('op-1'); // non-admin delete
      await service.revoke('op-1'); // non-admin revoke
      await service.update('op-1', { role: ApiKeyRole.VIEWER }); // demote of a non-admin
      await service.update('adm-1', { name: 'renamed' }); // benign update of an admin

      expect(lockRun).not.toHaveBeenCalled();
    });
  });

  // ── last-admin invariant vs session-scoped admins ─────────────────

  describe('last-admin invariant vs session-scoped admins', () => {
    // Key-lifecycle routes are fenced behind @RequireUnscopedKey, so a session-scoped admin can
    // never manage keys: it must NOT count as a surviving admin, and scoping the last unscoped
    // admin must be rejected like a demotion — otherwise the system locks itself out for good.
    const unscopedAdmin = (id: string) => createMockApiKey({ id, role: ApiKeyRole.ADMIN });
    const scopedAdmin = (id: string) => createMockApiKey({ id, role: ApiKeyRole.ADMIN, allowedSessions: ['sess-1'] });

    it('rejects deleting the last unscoped admin even while a session-scoped admin survives', async () => {
      setupKeys([unscopedAdmin('admin-a'), scopedAdmin('admin-scoped')]);

      await expect(service.delete('admin-a')).rejects.toThrow(/last active admin/i);
      expect(repository.remove).not.toHaveBeenCalled();
    });

    it('rejects revoking the last unscoped admin even while a session-scoped admin survives', async () => {
      setupKeys([unscopedAdmin('admin-a'), scopedAdmin('admin-scoped')]);

      await expect(service.revoke('admin-a')).rejects.toThrow(/last active admin/i);
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('rejects demoting the last unscoped admin even while a session-scoped admin survives', async () => {
      setupKeys([unscopedAdmin('admin-a'), scopedAdmin('admin-scoped')]);

      await expect(service.update('admin-a', { role: ApiKeyRole.OPERATOR })).rejects.toThrow(/last active admin/i);
    });

    it('rejects scoping the last unscoped admin — the same capability-stripping as a demotion', async () => {
      setupKeys([unscopedAdmin('admin-a'), scopedAdmin('admin-scoped')]);

      await expect(service.update('admin-a', { allowedSessions: ['sess-9'] })).rejects.toThrow(/last active admin/i);
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('treats an empty allowedSessions write as unscoped — not capability-stripping', async () => {
      setupKeys([unscopedAdmin('admin-a')]);

      await expect(service.update('admin-a', { allowedSessions: [] })).resolves.toBeDefined();
    });

    it('lets a session-scoped admin be deleted — it never counted toward the invariant', async () => {
      setupKeys([unscopedAdmin('admin-a'), scopedAdmin('admin-scoped')]);

      await expect(service.delete('admin-scoped')).resolves.toBeUndefined();
      expect(repository.remove).toHaveBeenCalledTimes(1);
    });

    it('allows stripping an unscoped admin when another unscoped admin remains', async () => {
      setupKeys([unscopedAdmin('admin-a'), unscopedAdmin('admin-b'), scopedAdmin('admin-scoped')]);

      await expect(service.update('admin-a', { allowedSessions: ['sess-9'] })).resolves.toBeDefined();
    });

    it('re-reads the target inside the critical section instead of trusting the pre-lock snapshot', async () => {
      // The pre-lock read sees a usable admin; a concurrent (already serialized) mutation demoted
      // it before this request's section ran. The fresh read must win — no spurious conflict.
      const stale = createMockApiKey({ id: 'admin-a', role: ApiKeyRole.ADMIN });
      const fresh = createMockApiKey({ id: 'admin-a', role: ApiKeyRole.OPERATOR });
      (repository.findOne as jest.Mock).mockResolvedValueOnce(stale).mockResolvedValue(fresh);
      (repository.count as jest.Mock).mockResolvedValue(0);
      (repository.remove as jest.Mock).mockImplementation((key: ApiKey) => Promise.resolve(key));

      await expect(service.delete('admin-a')).resolves.toBeUndefined();
      expect(repository.remove).toHaveBeenCalledWith(fresh);
    });
  });

  // ── validateApiKey ────────────────────────────────────────────────

  describe('validateApiKey', () => {
    it('should return the API key for a valid raw key', async () => {
      const rawKey = 'test-key';
      const key = createMockApiKey({ keyHash: hashKey(rawKey) });
      (repository.findOne as jest.Mock).mockResolvedValue(key);
      (repository.save as jest.Mock).mockImplementation(k => Promise.resolve(k));

      const result = await service.validateApiKey(rawKey);

      expect(result.id).toBe(key.id);
      expect(result.usageCount).toBe(1);
      expect(result.lastUsedAt).toBeDefined();
    });

    it('accepts a key padded with whitespace, as HTTP header parsing already does', async () => {
      // A key pasted with a stray space authenticates over REST (header values are trimmed in
      // transit) and must authenticate over the WebSocket handshake too, which carries the
      // literal string from the CONNECT payload.
      const rawKey = 'padded-key';
      const key = createMockApiKey({ keyHash: hashKey(rawKey) });
      (repository.findOne as jest.Mock).mockResolvedValue(key);
      (repository.save as jest.Mock).mockImplementation(k => Promise.resolve(k));

      await expect(service.validateApiKey(` ${rawKey}\n`)).resolves.toMatchObject({ id: key.id });
    });

    it('coalesces the usage-stat write within the throttle window', async () => {
      const rawKey = 'recent-key';
      const key = createMockApiKey({ keyHash: hashKey(rawKey), lastUsedAt: new Date(), usageCount: 5 });
      (repository.findOne as jest.Mock).mockResolvedValue(key);

      const result = await service.validateApiKey(rawKey);

      expect(repository.save).not.toHaveBeenCalled(); // throttled — no DB write this request
      expect(result.usageCount).toBe(6); // but the count is still reflected in-memory
      expect(result.lastUsedAt).toBeDefined();
    });

    it('flushes the usage-stat write once the throttle window has elapsed', async () => {
      const rawKey = 'stale-key';
      const key = createMockApiKey({
        keyHash: hashKey(rawKey),
        lastUsedAt: new Date(Date.now() - 5 * 60_000),
        usageCount: 5,
      });
      (repository.findOne as jest.Mock).mockResolvedValue(key);
      (repository.save as jest.Mock).mockImplementation(k => Promise.resolve(k));

      await service.validateApiKey(rawKey);

      expect(repository.save).toHaveBeenCalled(); // persisted after the window
    });

    it('should throw UnauthorizedException for invalid key', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(null);

      await expect(service.validateApiKey('wrong-key')).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException for revoked key', async () => {
      const key = createMockApiKey({ isActive: false, keyHash: hashKey('revoked') });
      (repository.findOne as jest.Mock).mockResolvedValue(key);

      await expect(service.validateApiKey('revoked')).rejects.toThrow('API key is revoked');
    });

    it('should throw UnauthorizedException for expired key', async () => {
      const expired = new Date();
      expired.setDate(expired.getDate() - 1);
      const key = createMockApiKey({ expiresAt: expired, keyHash: hashKey('expired') });
      (repository.findOne as jest.Mock).mockResolvedValue(key);

      await expect(service.validateApiKey('expired')).rejects.toThrow('API key has expired');
    });

    it('should throw UnauthorizedException when IP is not allowed', async () => {
      const key = createMockApiKey({
        allowedIps: ['10.0.0.1'],
        keyHash: hashKey('ip-restricted'),
      });
      (repository.findOne as jest.Mock).mockResolvedValue(key);

      await expect(service.validateApiKey('ip-restricted', '192.168.1.1')).rejects.toThrow('IP address not allowed');
    });

    it('should pass when client IP matches allowed IPs', async () => {
      const key = createMockApiKey({
        allowedIps: ['10.0.0.1'],
        keyHash: hashKey('ip-ok'),
      });
      (repository.findOne as jest.Mock).mockResolvedValue(key);
      (repository.save as jest.Mock).mockImplementation(k => Promise.resolve(k));

      const result = await service.validateApiKey('ip-ok', '10.0.0.1');
      expect(result.id).toBe(key.id);
    });

    it('should fail closed when an IP whitelist is set but the client IP is unknown', async () => {
      const key = createMockApiKey({
        allowedIps: ['10.0.0.1'],
        keyHash: hashKey('ip-no-client'),
      });
      (repository.findOne as jest.Mock).mockResolvedValue(key);

      await expect(service.validateApiKey('ip-no-client')).rejects.toThrow('Client IP could not be determined');
    });

    it('rejects a malformed client IP instead of coercing it into an allowed range', async () => {
      const key = createMockApiKey({
        allowedIps: ['10.0.0.1/32'],
        keyHash: hashKey('ip-malformed'),
      });
      (repository.findOne as jest.Mock).mockResolvedValue(key);

      // The previous lenient parser read '10.0.0.1abc' as 10.0.0.1 and let it through; the shared
      // hardened matcher rejects a non-numeric octet, so the per-key whitelist holds.
      await expect(service.validateApiKey('ip-malformed', '10.0.0.1abc')).rejects.toThrow('IP address not allowed');
    });

    it('should throw UnauthorizedException when session not in allowedSessions', async () => {
      const key = createMockApiKey({
        allowedSessions: ['session-A'],
        keyHash: hashKey('sess-restricted'),
      });
      (repository.findOne as jest.Mock).mockResolvedValue(key);

      await expect(service.validateApiKey('sess-restricted', undefined, 'session-B')).rejects.toThrow(
        'API key not authorized for this session',
      );
    });
  });

  // ── usage-stat lost-update safety + shutdown flush ────────────────

  describe('usage-stat lost-update safety', () => {
    it('keeps the accumulated delta when the windowed save fails, and the next flush carries it', async () => {
      const rawKey = 'flaky-key';
      // Fresh row per findOne, as TypeORM returns it (no identity map): the DB state never
      // reflects the failed write, so the delta must survive in the pending map.
      const freshRow = () =>
        createMockApiKey({ keyHash: hashKey(rawKey), lastUsedAt: new Date(Date.now() - 5 * 60_000), usageCount: 5 });
      (repository.findOne as jest.Mock).mockImplementation(() => Promise.resolve(freshRow()));
      (repository.save as jest.Mock)
        .mockRejectedValueOnce(new Error('db write failed'))
        .mockImplementation(k => Promise.resolve(k));

      // The windowed write fails: the request still succeeds (the key is valid) and the delta is kept.
      const first = await service.validateApiKey(rawKey);
      expect(first.usageCount).toBe(6);

      // Still due on the next request (DB lastUsedAt was never written) → the retry persists the
      // failed delta plus this request's increment — nothing is lost.
      await service.validateApiKey(rawKey);
      const saves = (repository.save as jest.Mock).mock.calls as Array<[ApiKey]>;
      expect(saves[1][0].usageCount).toBe(7); // DB 5 + failed delta 1 + this request 1

      // The successful retry drained the accumulator — nothing left for the shutdown flush.
      await service.onModuleDestroy();
      expect(repository.increment).not.toHaveBeenCalled();
    });
  });

  describe('usage-stat shutdown flush', () => {
    it('flushes pending deltas on module destroy with an atomic increment, only once', async () => {
      const rawKey = 'recent-key';
      (repository.findOne as jest.Mock).mockResolvedValue(
        createMockApiKey({ keyHash: hashKey(rawKey), lastUsedAt: new Date(), usageCount: 5 }),
      );
      (repository.increment as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.validateApiKey(rawKey); // inside the throttle window → coalesced, no DB write
      expect(repository.save).not.toHaveBeenCalled();

      await service.onModuleDestroy();
      expect(repository.increment).toHaveBeenCalledWith({ id: 'uuid-1' }, 'usageCount', 1);

      await service.onModuleDestroy(); // idempotent — nothing left pending
      expect(repository.increment).toHaveBeenCalledTimes(1);
    });

    it('does nothing on destroy when there is nothing pending', async () => {
      await service.onModuleDestroy();
      expect(repository.increment).not.toHaveBeenCalled();
    });

    it('tolerates a failing flush (destroy still resolves — stats are best-effort)', async () => {
      const rawKey = 'recent-key';
      (repository.findOne as jest.Mock).mockResolvedValue(
        createMockApiKey({ keyHash: hashKey(rawKey), lastUsedAt: new Date(), usageCount: 5 }),
      );
      (repository.increment as jest.Mock).mockRejectedValue(new Error('db gone'));

      await service.validateApiKey(rawKey);
      await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    });
  });

  // ── bootstrap API key file (data/.api-key) staleness ─────────────

  describe('bootstrap API key file (data/.api-key)', () => {
    let existsSpy: jest.SpyInstance;
    let readSpy: jest.Mock;
    let unlinkSpy: jest.Mock;
    let logSpy: jest.SpyInstance;

    const bannerText = (): string => (logSpy.mock.calls as unknown[][]).map(call => String(call[0])).join('\n');

    beforeEach(() => {
      existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(false);
      readSpy = jest.spyOn(fs, 'readFileSync') as unknown as jest.Mock;
      readSpy.mockReturnValue('');
      unlinkSpy = jest.spyOn(fs, 'unlinkSync') as unknown as jest.Mock;
      unlinkSpy.mockImplementation(() => undefined);
      logSpy = jest
        .spyOn((service as unknown as { logger: { log: (...args: unknown[]) => void } }).logger, 'log')
        .mockImplementation(() => undefined);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('revoke removes the bootstrap key file when it still holds the revoked key', async () => {
      const key = createMockApiKey({ isActive: true }); // keyHash matches hashKey('test-key')
      (repository.findOne as jest.Mock).mockResolvedValue(key);
      (repository.save as jest.Mock).mockImplementation(k => Promise.resolve(k));
      existsSpy.mockReturnValue(true);
      readSpy.mockReturnValue('test-key\n');

      await service.revoke('uuid-1');

      expect(unlinkSpy).toHaveBeenCalledWith(expect.stringContaining('.api-key'));
    });

    it('revoke leaves the file alone when it holds a different (still live) key', async () => {
      const key = createMockApiKey({ isActive: true });
      (repository.findOne as jest.Mock).mockResolvedValue(key);
      (repository.save as jest.Mock).mockImplementation(k => Promise.resolve(k));
      existsSpy.mockReturnValue(true);
      readSpy.mockReturnValue('another-key');

      await service.revoke('uuid-1');

      expect(unlinkSpy).not.toHaveBeenCalled();
    });

    it('delete removes the bootstrap key file when it still holds the deleted key', async () => {
      const key = createMockApiKey();
      (repository.findOne as jest.Mock).mockResolvedValue(key);
      (repository.remove as jest.Mock).mockResolvedValue(key);
      existsSpy.mockReturnValue(true);
      readSpy.mockReturnValue('test-key');

      await service.delete('uuid-1');

      expect(unlinkSpy).toHaveBeenCalledWith(expect.stringContaining('.api-key'));
    });

    it('tolerates a missing file on revoke (nothing to clean up)', async () => {
      const key = createMockApiKey({ isActive: true });
      (repository.findOne as jest.Mock).mockResolvedValue(key);
      (repository.save as jest.Mock).mockImplementation(k => Promise.resolve(k));
      existsSpy.mockReturnValue(false);

      await service.revoke('uuid-1');

      expect(unlinkSpy).not.toHaveBeenCalled();
    });

    it('boot removes a stale bootstrap file and the banner no longer advertises the dead key', async () => {
      (repository.count as jest.Mock).mockResolvedValue(1); // not first boot → the file path is consulted
      existsSpy.mockReturnValue(true);
      readSpy.mockReturnValue('owa_k1_deaddeaddead');
      (repository.findOne as jest.Mock).mockResolvedValue(null); // hash no longer resolves to any key

      await service.onModuleInit();

      expect(unlinkSpy).toHaveBeenCalledWith(expect.stringContaining('.api-key'));
      expect(bannerText()).toContain('(check dashboard for keys)');
      expect(bannerText()).not.toContain('owa_k1_d'); // no fingerprint of the dead key
    });

    it('boot keeps the bootstrap file when only the pepper changed (prefix matches, hash does not)', async () => {
      const warnSpy = jest
        .spyOn((service as unknown as { logger: { warn: (...args: unknown[]) => void } }).logger, 'warn')
        .mockImplementation(() => undefined);
      (repository.count as jest.Mock).mockResolvedValue(1);
      existsSpy.mockReturnValue(true);
      readSpy.mockReturnValue('owa_k1_pepperchanged');
      // The hash lookup misses (the current pepper hashes the same key differently), but the
      // unhashed prefix still resolves to the live row → wrong pepper, not a stale file.
      (repository.findOne as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValue(createMockApiKey({ keyPrefix: 'owa_k1_peppe', keyHash: 'hash-under-old-pepper' }));

      await service.onModuleInit();

      expect(repository.findOne).toHaveBeenCalledWith({ where: { keyPrefix: 'owa_k1_peppe' } });
      expect(unlinkSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('API_KEY_PEPPER'), expect.anything());
      expect(bannerText()).toContain('(check dashboard for keys)'); // still not advertised as live
    });

    it('boot still deletes the file when no row carries the file key prefix (genuine staleness)', async () => {
      (repository.count as jest.Mock).mockResolvedValue(1);
      existsSpy.mockReturnValue(true);
      readSpy.mockReturnValue('owa_k1_deaddeaddead');
      (repository.findOne as jest.Mock).mockResolvedValue(null); // neither the hash nor the prefix resolves

      await service.onModuleInit();

      expect(repository.findOne).toHaveBeenCalledWith({ where: { keyPrefix: 'owa_k1_deadd' } });
      expect(unlinkSpy).toHaveBeenCalledWith(expect.stringContaining('.api-key'));
    });

    it('boot treats a revoked bootstrap key as stale too', async () => {
      (repository.count as jest.Mock).mockResolvedValue(1);
      existsSpy.mockReturnValue(true);
      readSpy.mockReturnValue('test-key');
      (repository.findOne as jest.Mock).mockResolvedValue(createMockApiKey({ isActive: false }));

      await service.onModuleInit();

      expect(unlinkSpy).toHaveBeenCalled();
      expect(bannerText()).toContain('(check dashboard for keys)');
    });

    it('boot keeps a live bootstrap key: file untouched, banner shows the masked fingerprint', async () => {
      (repository.count as jest.Mock).mockResolvedValue(1);
      existsSpy.mockReturnValue(true);
      readSpy.mockReturnValue('test-key');
      (repository.findOne as jest.Mock).mockResolvedValue(createMockApiKey({ isActive: true }));

      await service.onModuleInit();

      expect(unlinkSpy).not.toHaveBeenCalled();
      expect(bannerText()).toContain('(full key in data/.api-key');
    });
  });

  // ── hasPermission ─────────────────────────────────────────────────

  describe('hasPermission', () => {
    it('should allow ADMIN to access ADMIN routes', () => {
      const key = createMockApiKey({ role: ApiKeyRole.ADMIN });
      expect(service.hasPermission(key, ApiKeyRole.ADMIN)).toBe(true);
    });

    it('should allow ADMIN to access OPERATOR routes', () => {
      const key = createMockApiKey({ role: ApiKeyRole.ADMIN });
      expect(service.hasPermission(key, ApiKeyRole.OPERATOR)).toBe(true);
    });

    it('should allow ADMIN to access VIEWER routes', () => {
      const key = createMockApiKey({ role: ApiKeyRole.ADMIN });
      expect(service.hasPermission(key, ApiKeyRole.VIEWER)).toBe(true);
    });

    it('should deny VIEWER access to OPERATOR routes', () => {
      const key = createMockApiKey({ role: ApiKeyRole.VIEWER });
      expect(service.hasPermission(key, ApiKeyRole.OPERATOR)).toBe(false);
    });

    it('should deny OPERATOR access to ADMIN routes', () => {
      const key = createMockApiKey({ role: ApiKeyRole.OPERATOR });
      expect(service.hasPermission(key, ApiKeyRole.ADMIN)).toBe(false);
    });
  });

  // ── hashKey (via validateApiKey) ──────────────────────────────────

  describe('hashKey (determinism)', () => {
    it('should produce the same hash for the same input', () => {
      const key1 = createMockApiKey({ keyHash: hashKey('same-key') });
      const key2 = createMockApiKey({ keyHash: hashKey('same-key') });

      expect(key1.keyHash).toBe(key2.keyHash);
    });

    it('should produce different hashes for different inputs', () => {
      expect(hashKey('key-a')).not.toBe(hashKey('key-b'));
    });
  });

  // ── isIpAllowed / ipInCidr (via validateApiKey) ───────────────────

  describe('IP CIDR validation (via validateApiKey)', () => {
    it('should allow IP within CIDR range', async () => {
      const key = createMockApiKey({
        allowedIps: ['192.168.1.0/24'],
        keyHash: hashKey('cidr-ok'),
      });
      (repository.findOne as jest.Mock).mockResolvedValue(key);
      (repository.save as jest.Mock).mockImplementation(k => Promise.resolve(k));

      const result = await service.validateApiKey('cidr-ok', '192.168.1.100');
      expect(result.id).toBe(key.id);
    });

    it('should reject IP outside CIDR range', async () => {
      const key = createMockApiKey({
        allowedIps: ['192.168.1.0/24'],
        keyHash: hashKey('cidr-fail'),
      });
      (repository.findOne as jest.Mock).mockResolvedValue(key);

      await expect(service.validateApiKey('cidr-fail', '10.0.0.1')).rejects.toThrow('IP address not allowed');
    });

    it('should handle mixed exact IP and CIDR entries', async () => {
      const key = createMockApiKey({
        allowedIps: ['10.0.0.5', '192.168.0.0/16'],
        keyHash: hashKey('mixed'),
      });
      (repository.findOne as jest.Mock).mockResolvedValue(key);
      (repository.save as jest.Mock).mockImplementation(k => Promise.resolve(k));

      // Exact match
      const r1 = await service.validateApiKey('mixed', '10.0.0.5');
      expect(r1.id).toBe(key.id);

      // Reset usage for second call
      key.usageCount = 0;

      // CIDR match
      const r2 = await service.validateApiKey('mixed', '192.168.50.1');
      expect(r2.id).toBe(key.id);
    });
  });

  // ── API_KEY_PEPPER wiring ─────────────────────────────────────────
  // Proves the service's hashing path actually reads the env var (not just the pure helper). We
  // assert on the keyHash the service QUERIES findOne with, since the mock returns regardless.
  describe('hashKey reads API_KEY_PEPPER', () => {
    const ORIGINAL_ENV = process.env;
    afterEach(() => {
      process.env = ORIGINAL_ENV;
    });

    const queriedHash = async (rawKey: string): Promise<string> => {
      (repository.findOne as jest.Mock).mockResolvedValue(null);
      await expect(service.validateApiKey(rawKey)).rejects.toThrow(UnauthorizedException);
      const calls = (repository.findOne as jest.Mock).mock.calls as Array<[{ where: { keyHash: string } }]>;
      return calls[0][0].where.keyHash;
    };

    it('hashes with HMAC-SHA256 when the pepper is set', async () => {
      process.env = { ...ORIGINAL_ENV, API_KEY_PEPPER: 'server-pepper' };
      const queried = await queriedHash('owa_raw_key');
      expect(queried).toBe(createHmac('sha256', 'server-pepper').update('owa_raw_key').digest('hex'));
      expect(queried).not.toBe(createHash('sha256').update('owa_raw_key').digest('hex'));
    });

    it('hashes with plain SHA-256 when the pepper is unset (existing keys keep validating)', async () => {
      process.env = { ...ORIGINAL_ENV };
      delete process.env.API_KEY_PEPPER;
      const queried = await queriedHash('owa_raw_key');
      expect(queried).toBe(createHash('sha256').update('owa_raw_key').digest('hex'));
    });
  });
});
