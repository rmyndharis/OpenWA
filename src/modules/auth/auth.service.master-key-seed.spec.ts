// Spread the real fs so every method passes through, but as configurable props the test can spy on.
jest.mock('fs', () => ({ __esModule: true, ...jest.requireActual<typeof import('fs')>('fs') }));

import * as fs from 'fs';
import type { Repository } from 'typeorm';
import type { ModuleRef } from '@nestjs/core';
import { AuthService } from './auth.service';
import type { ApiKeyUsageTracker } from './api-key-usage-tracker.service';
import { hashApiKey } from './api-key-hash';
import { ApiKeyRole, type ApiKey } from './entities/api-key.entity';
import { LoggerService } from '../../common/services/logger.service';

// An API_MASTER_KEY is taken verbatim, so every character of it is part of the secret. The operator already
// holds it, so it is neither printed in the startup banner nor listed as the key's prefix.
const MASTER = 'Acme-Prod-Gateway-Master-2026-Q4!';
const KEY_FILE = '/isolated/virtual/path/.api-key';
const MARKER = '(master key)';

describe('the first admin key seeded into an empty key table', () => {
  const saved = {
    API_MASTER_KEY: process.env.API_MASTER_KEY,
    ALLOW_DEV_API_KEY: process.env.ALLOW_DEV_API_KEY,
    BOOTSTRAP_KEY_FILE: process.env.BOOTSTRAP_KEY_FILE,
  };
  let written: string | undefined;
  let created: Partial<ApiKey>[];
  let banner: () => string;
  let warnings: () => string;

  /** Boots an AuthService against an empty table, with the key file write stubbed (or failing). */
  async function boot(env: { master?: string; dev?: boolean }, writeFails = false): Promise<void> {
    if (env.master === undefined) delete process.env.API_MASTER_KEY;
    else process.env.API_MASTER_KEY = env.master;
    if (env.dev) process.env.ALLOW_DEV_API_KEY = 'true';
    else delete process.env.ALLOW_DEV_API_KEY;
    process.env.BOOTSTRAP_KEY_FILE = KEY_FILE;
    jest.spyOn(fs, 'chmodSync').mockImplementation(() => undefined);
    jest.spyOn(fs, 'writeFileSync').mockImplementation((_file, data) => {
      if (writeFails) throw new Error('read-only file system');
      if (typeof data === 'string') written = data;
    });
    const log = jest.spyOn(LoggerService.prototype, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    banner = () => (log.mock.calls as unknown[][]).map(call => String(call[0])).join('\n');
    warnings = () => JSON.stringify(warn.mock.calls);

    const repository = {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((dto: Partial<ApiKey>) => {
        created.push(dto);
        return dto as ApiKey;
      }),
      save: jest.fn((entity: ApiKey) => Promise.resolve(entity)),
    } as unknown as Repository<ApiKey>;
    await new AuthService(repository, {} as ApiKeyUsageTracker, {} as ModuleRef).onModuleInit();
  }

  beforeEach(() => {
    written = undefined;
    created = [];
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    jest.restoreAllMocks();
  });

  describe('startup banner', () => {
    it('prints no part of an API_MASTER_KEY and names the file that holds it', async () => {
      await boot({ master: MASTER });

      expect(banner()).toContain('API Key');
      expect(banner()).not.toContain(MASTER.slice(0, 8));
      expect(banner()).toContain(`(the configured API_MASTER_KEY; also in ${KEY_FILE})`);
      // The file still holds the key: backups and the install notes read it from there.
      expect(written).toBe(MASTER);
    });

    it('names no file when the key file could not be written', async () => {
      await boot({ master: MASTER }, true);

      expect(banner()).not.toContain(MASTER.slice(0, 8));
      expect(banner()).not.toContain(KEY_FILE);
      expect(banner()).toContain('(the configured API_MASTER_KEY)');
      expect(warnings()).toContain('Could not save API key file');
      expect(warnings()).not.toContain(MASTER.slice(0, 8));
    });

    it('prints no part of an API_MASTER_KEY that looks like a generated key', async () => {
      const lookalike = `owa_k1_${'ab12'.repeat(16)}`;
      await boot({ master: lookalike });

      expect(banner()).not.toContain(lookalike.slice(0, 8));
      expect(banner()).toContain('(the configured API_MASTER_KEY; also in');
    });

    it('prints a generated key in full, and it is the key written to the file', async () => {
      await boot({});

      expect(written).toMatch(/^owa_k1_[a-f0-9]{64}$/);
      expect(banner()).toContain('API Key (newly created)');
      expect(banner()).toContain(written!);
    });

    it('prints the public development key when it is switched on', async () => {
      await boot({ dev: true });

      expect(banner()).toContain('dev-admin-key');
      expect(written).toBe('dev-admin-key');
    });
  });

  describe('stored prefix', () => {
    it('is a fixed marker for an API_MASTER_KEY, whose characters are all secret', async () => {
      await boot({ master: MASTER });

      expect(created).toHaveLength(1);
      expect(created[0].keyPrefix).toBe(MARKER);
      expect(created[0].keyPrefix).toHaveLength(12);
      expect(created[0].role).toBe(ApiKeyRole.ADMIN);
    });

    it('is the fixed marker for an API_MASTER_KEY that looks like a generated key', async () => {
      await boot({ master: `owa_k1_${'ab12'.repeat(16)}` });

      expect(created[0].keyPrefix).toBe(MARKER);
    });

    it('stays the first 12 characters of a generated key', async () => {
      await boot({});

      expect(created[0].keyPrefix).toBe(written!.substring(0, 12));
      expect(created[0].keyPrefix).toMatch(/^owa_k1_[a-f0-9]{5}$/);
    });

    it('stays the first 12 characters of the development key', async () => {
      await boot({ dev: true });

      expect(created[0].keyPrefix).toBe('dev-admin-ke');
    });
  });
});

describe('a bootstrap key file that no stored hash matches (API_KEY_PEPPER changed)', () => {
  const saved = { BOOTSTRAP_KEY_FILE: process.env.BOOTSTRAP_KEY_FILE };
  let rows: ApiKey[];
  let unlink: jest.SpyInstance;
  let warn: jest.SpyInstance;

  const row = (overrides: Partial<ApiKey>): ApiKey =>
    ({
      id: 'row-1',
      name: 'Default Admin Key',
      keyHash: 'hash-under-the-old-pepper',
      keyPrefix: MASTER.substring(0, 12),
      role: ApiKeyRole.ADMIN,
      isActive: true,
      expiresAt: null,
      ...overrides,
    }) as ApiKey;

  /** Boots over a non-empty table whose bootstrap file holds `fileKey`; no row matches its hash. */
  async function bootWithFile(fileKey: string): Promise<void> {
    process.env.BOOTSTRAP_KEY_FILE = KEY_FILE;
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readFileSync').mockReturnValue(fileKey);
    unlink = jest.spyOn(fs, 'unlinkSync').mockImplementation(() => undefined);
    jest.spyOn(LoggerService.prototype, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    const repository = {
      count: jest.fn().mockResolvedValue(rows.length),
      findOne: jest.fn((options: { where: { keyHash?: string; keyPrefix?: string } }) =>
        Promise.resolve(
          rows.find(r => r.keyHash === options.where.keyHash || r.keyPrefix === options.where.keyPrefix) ?? null,
        ),
      ),
    } as unknown as Repository<ApiKey>;
    await new AuthService(repository, {} as ApiKeyUsageTracker, {} as ModuleRef).onModuleInit();
  }

  afterEach(() => {
    if (saved.BOOTSTRAP_KEY_FILE === undefined) delete process.env.BOOTSTRAP_KEY_FILE;
    else process.env.BOOTSTRAP_KEY_FILE = saved.BOOTSTRAP_KEY_FILE;
    jest.restoreAllMocks();
  });

  it('keeps the file of a master key seeded with its first characters as the prefix', async () => {
    rows = [row({})];
    await bootWithFile(MASTER);

    expect(unlink).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('API_KEY_PEPPER'),
      expect.objectContaining({ action: 'bootstrap_key_pepper_mismatch' }),
    );
  });

  it('keeps the file of a master key seeded under the fixed marker', async () => {
    rows = [row({ keyPrefix: MARKER })];
    await bootWithFile(MASTER);

    expect(unlink).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('API_KEY_PEPPER'),
      expect.objectContaining({ action: 'bootstrap_key_pepper_mismatch' }),
    );
  });

  it('keeps the file of a master key that looks like a generated key, seeded under the marker', async () => {
    rows = [row({ keyPrefix: MARKER })];
    await bootWithFile(`owa_k1_${'ab12'.repeat(16)}`);

    expect(unlink).not.toHaveBeenCalled();
  });

  it('removes the file when no stored key carries its prefix or the marker', async () => {
    rows = [row({ keyPrefix: 'owa_k1_other' })];
    await bootWithFile(MASTER);

    expect(unlink).toHaveBeenCalledWith(KEY_FILE);
  });

  it('names the key by id in the warning and carries no character of the key', async () => {
    rows = [row({ keyPrefix: MARKER })];
    await bootWithFile(MASTER);

    expect(warn).toHaveBeenCalledWith(expect.any(String), { keyId: 'row-1', action: 'bootstrap_key_pepper_mismatch' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(MASTER.slice(0, 4));
  });

  it('names a row seeded with its first characters by id too', async () => {
    rows = [row({})];
    await bootWithFile(MASTER);

    expect(JSON.stringify(warn.mock.calls)).not.toContain(MASTER.slice(0, 4));
  });
});

describe('the startup banner of a later boot', () => {
  const saved = { API_MASTER_KEY: process.env.API_MASTER_KEY, BOOTSTRAP_KEY_FILE: process.env.BOOTSTRAP_KEY_FILE };
  const GENERATED = `owa_k1_${'ab12'.repeat(16)}`;
  const PAREN = `(${MASTER}`;

  /**
   * Boots over a non-empty table whose live row, stored with `keyPrefix`, matches the key in the bootstrap file;
   * without a file key there is no live key to point at. `configured` is the API_MASTER_KEY still set.
   */
  async function bannerOfLaterBoot(fileKey: string | null, keyPrefix?: string, configured?: string): Promise<string> {
    process.env.BOOTSTRAP_KEY_FILE = KEY_FILE;
    if (configured === undefined) delete process.env.API_MASTER_KEY;
    else process.env.API_MASTER_KEY = configured;
    jest.spyOn(fs, 'existsSync').mockReturnValue(fileKey !== null);
    jest.spyOn(fs, 'readFileSync').mockReturnValue(fileKey ?? '');
    const log = jest.spyOn(LoggerService.prototype, 'log').mockImplementation(() => undefined);
    const row = {
      id: 'row-1',
      keyHash: hashApiKey(fileKey ?? '', process.env.API_KEY_PEPPER),
      keyPrefix,
      isActive: true,
      expiresAt: null,
    } as ApiKey;
    const repository = {
      count: jest.fn().mockResolvedValue(1),
      findOne: jest.fn((options: { where: { keyHash?: string } }) =>
        Promise.resolve(options.where.keyHash === row.keyHash ? row : null),
      ),
    } as unknown as Repository<ApiKey>;
    await new AuthService(repository, {} as ApiKeyUsageTracker, {} as ModuleRef).onModuleInit();
    return (log.mock.calls as unknown[][]).map(call => String(call[0])).join('\n');
  }

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    jest.restoreAllMocks();
  });

  it('prints nothing of a seeded API_MASTER_KEY that looks like a generated key', async () => {
    const banner = await bannerOfLaterBoot(GENERATED, MARKER);

    expect(banner).not.toContain(GENERATED.slice(0, 8));
    expect(banner).toContain(`(full key in ${KEY_FILE})`);
  });

  it('prints no character of a seeded API_MASTER_KEY that starts with an opening parenthesis', async () => {
    for (const keyPrefix of [MARKER, PAREN.substring(0, 12)]) {
      const banner = await bannerOfLaterBoot(PAREN, keyPrefix);

      expect(banner).not.toContain(PAREN.slice(0, 8));
      expect(banner).toContain(`(full key in ${KEY_FILE})`);
      jest.restoreAllMocks();
    }
  });

  it('prints no fingerprint for the configured API_MASTER_KEY, whatever prefix its row holds', async () => {
    // A row seeded by an earlier release holds the first 12 characters of a key the operator chose.
    const banner = await bannerOfLaterBoot(GENERATED, GENERATED.substring(0, 12), GENERATED);

    expect(banner).not.toContain(GENERATED.slice(0, 8));
    expect(banner).toContain(`(full key in ${KEY_FILE})`);
  });

  it('still prints the fingerprint of a generated key, and no more than it', async () => {
    const banner = await bannerOfLaterBoot(GENERATED, GENERATED.substring(0, 12));

    expect(banner).toContain(GENERATED.slice(0, 8));
    expect(banner).not.toContain(GENERATED.slice(0, 9));
    expect(banner).toContain(`(full key in ${KEY_FILE})`);
  });

  it('prints no fingerprint when the live row has no readable prefix', async () => {
    const banner = await bannerOfLaterBoot(GENERATED, undefined);

    expect(banner).not.toContain(GENERATED.slice(0, 8));
    expect(banner).toContain(`(full key in ${KEY_FILE})`);
  });

  it('points at the dashboard when no key file is left', async () => {
    expect(await bannerOfLaterBoot(null)).toContain('(check dashboard for keys)');
  });
});
