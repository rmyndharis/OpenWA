import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UnauthorizedException, NotFoundException } from '@nestjs/common';
import { createHash, createHmac } from 'crypto';
import { AuthService, resolveSeedApiKey, bannerKeyLine } from './auth.service';
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
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: getRepositoryToken(ApiKey, 'main'),
          useValue: repository,
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

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
  });

  describe('revoke', () => {
    it('should set isActive to false', async () => {
      const key = createMockApiKey({ isActive: true });
      (repository.findOne as jest.Mock).mockResolvedValue(key);
      (repository.save as jest.Mock).mockImplementation(k => Promise.resolve(k));

      const result = await service.revoke('uuid-1');

      expect(result.isActive).toBe(false);
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
