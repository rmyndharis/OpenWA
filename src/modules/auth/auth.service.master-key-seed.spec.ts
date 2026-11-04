// Spread the real fs so every method passes through, but as configurable props the test can spy on.
jest.mock('fs', () => ({ __esModule: true, ...jest.requireActual<typeof import('fs')>('fs') }));

import * as fs from 'fs';
import type { Repository } from 'typeorm';
import type { ModuleRef } from '@nestjs/core';
import { AuthService } from './auth.service';
import type { ApiKeyUsageTracker } from './api-key-usage-tracker.service';
import type { ApiKey } from './entities/api-key.entity';
import { LoggerService } from '../../common/services/logger.service';

// An API_MASTER_KEY is taken verbatim, so every character of it is part of the secret. The operator already
// holds it, so the startup banner on the boot that seeds it names where it is kept instead of printing it.
const MASTER = 'Acme-Prod-Gateway-Master-2026-Q4!';
const KEY_FILE = '/isolated/virtual/path/.api-key';

describe('the first admin key seeded into an empty key table', () => {
  const saved = {
    API_MASTER_KEY: process.env.API_MASTER_KEY,
    ALLOW_DEV_API_KEY: process.env.ALLOW_DEV_API_KEY,
    BOOTSTRAP_KEY_FILE: process.env.BOOTSTRAP_KEY_FILE,
  };
  let written: string | undefined;
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
      written = String(data);
    });
    const log = jest.spyOn(LoggerService.prototype, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    banner = () => (log.mock.calls as unknown[][]).map(call => String(call[0])).join('\n');
    warnings = () => JSON.stringify(warn.mock.calls);

    const repository = {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((dto: Partial<ApiKey>) => dto as ApiKey),
      save: jest.fn((entity: ApiKey) => Promise.resolve(entity)),
    } as unknown as Repository<ApiKey>;
    await new AuthService(repository, {} as ApiKeyUsageTracker, {} as ModuleRef).onModuleInit();
  }

  beforeEach(() => {
    written = undefined;
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
});
